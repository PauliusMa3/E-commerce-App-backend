const jwt = require("jsonwebtoken");
const bcrypt = require("bcrypt");
const stripe = require("stripe")(process.env.STRIPE_SECRET);
const { randomBytes } = require("crypto");
const { promisify } = require("util");
const { transport, makeNiceEmail } = require("../mail");

const Mutation = {
  async createItem(parent, args, ctx, info) {
    if (!ctx.request.userId) {
      throw new Error("You must be logged in to sell your item!");
    }

    return await ctx.db.mutation.createItem(
      {
        data: {
          ...args,
          user: {
            connect: {
              id: ctx.request.userId
            }
          }
        }
      },
      info
    );
  },

  async deleteItem(parent, args, ctx, info) {
    if (!ctx.request.userId) {
      throw new Error("You must sign in to complete this operation!");
    }

    const user = await ctx.db.query.user(
      {
        where: {
          id: ctx.request.userId
        }
      },
      `{id, permissions}`
    );

    const item = await ctx.db.query.item(
      {
        where: {
          id: args.id
        }
      },
      `{ id title user { id }}`
    );

    const ownsItem = item.user.id === user.id;

    const hasPermissions = user.permissions.some(permission =>
      ["ADMIN", "ITEMDELETE"].includes(permission)
    );

    if (!ownsItem && !hasPermissions) {
      throw new Error("You don't have permissions to perform this operation.");
    }

    return await ctx.db.mutation.deleteItem(
      {
        where: {
          id: args.id
        }
      },
      info
    );
  },

  async editItem(parent, args, ctx, info) {
    if (!ctx.request.userId) {
      throw new Error("You must be logged to do this operation!");
    }

    const user = await ctx.db.query.user(
      {
        where: {
          id: ctx.request.userId
        }
      },
      `{id, permissions}`
    );

    const item = await ctx.db.query.item(
      {
        where: {
          id: args.id
        }
      },
      `{id title user { id }}`
    );

    const ownsItem = item.user.id === user.id;

    console.log("user permissions: ", user.permissions);
    const hasPermissions = user.permissions.some(permission =>
      ["ADMIN", "ITEMUPDATE"].includes(permission)
    );

    if (!hasPermissions && !ownsItem) {
      throw new Error("You don't have permission to do this!");
    }

    const { title, price, description } = args;

    return await ctx.db.mutation.updateItem(
      {
        where: {
          id: item.id
        },
        data: {
          title,
          description,
          price
        }
      },
      info
    );
  },

  async signup(parent, args, ctx, info) {
    // Make email lowercase to avoid future collisions

    args.email = args.email.toLowerCase();

    const alreadyRegisteredUser = await ctx.db.query.user({
      where: {
        email: args.email
      }
    });

    if (alreadyRegisteredUser) {
      throw new Error("This user has already been taken");
    }

    const password = await bcrypt.hash(args.password, 12);

    const user = await ctx.db.mutation.createUser(
      {
        data: {
          ...args,
          password,
          permissions: { set: ["USER"] }
        }
      },
      info
    );

    const token = jwt.sign({ userId: user.id }, process.env.APP_SECRET);
    // We set the jwt as a cookie on the response
    ctx.response.cookie("token", token, {
      httpOnly: true,
      maxAge: 1000 * 60 * 60 * 24 * 365
    });

    return user;
  },

  async signin(parent, args, ctx, info) {
    const user = await ctx.db.query.user({
      where: {
        email: args.email
      }
    });

    if (!user) {
      throw new Error(`No such user found for email ${args.email}`);
    }
    const match = await bcrypt.compare(args.password, user.password);

    if (!match) {
      throw new Error("These credentials do not match our records.");
    }

    const token = jwt.sign({ userId: user.id }, process.env.APP_SECRET);
    // We set the jwt as a cookie on the response
    ctx.response.cookie("token", token, {
      httpOnly: true,
      maxAge: 1000 * 60 * 60 * 24 * 365
    });

    return user;
  },

  async addToCart(parent, args, ctx, info) {
    if (!ctx.request.userId) {
      throw new Error("You must be logged to add items to the cart!");
    }

    const [existingCartItem] = await ctx.db.query.cartItems({
      where: {
        user: { id: ctx.request.userId },
        item: {
          id: args.id
        }
      }
    });

    // if cartItem  is already in the cart then just update quantity of the cartItem

    if (existingCartItem) {
      return await ctx.db.mutation.updateCartItem(
        {
          where: {
            id: existingCartItem.id
          },
          data: {
            quantity: existingCartItem.quantity + 1
          }
        },
        info
      );
    }

    // if not found then just create new cart item. Default quantity value is set to 1 in the db

    return await ctx.db.mutation.createCartItem({
      data: {
        user: {
          connect: {
            id: ctx.request.userId
          }
        },
        item: {
          connect: {
            id: args.id
          }
        }
      }
    });
  },
  async removeFromCart(parent, args, ctx, info) {
    return await ctx.db.mutation.deleteCartItem({
      where: {
        id: args.id
      }
    });
  },
  async signout(parent, args, ctx, info) {
    ctx.response.clearCookie("token");
    return { message: "See you next time!" };
  },

  async createOrder(parent, args, ctx, info) {
    // check if user signed in
    if (!ctx.request.userId) {
      throw new Error("You must be signed in to complete the order!");
    }

    // Fetch user

    const user = await ctx.db.query.user(
      {
        where: {
          id: ctx.request.userId
        }
      },
      `
      {
      id
      name
      email
      cart {
        id
        quantity
        item {
          id
          title
          description
          price
          image
          largeImage
        }
      }
    }
    `
    );

    // recalculate total  price otherwise user can change total price on front end
    const amount = user.cart.reduce(
      (acc, cartItem) => acc + cartItem.quantity * cartItem.item.price,
      0
    );

    // charge the amount using stripe

    const charge = await stripe.charges.create({
      amount: amount,
      currency: "eur",
      source: args.token,
      description: `Charge for ${user.email}`
    });

    // create order items
    const orderItems = user.cart.map(cartItem => {
      const orderItem = {
        ...cartItem.item,
        quantity: cartItem.quantity,
        user: {
          connect: {
            id: user.id
          }
        }
      };
      delete orderItem.id;

      return orderItem;
    });

    const order = await ctx.db.mutation.createOrder({
      data: {
        total: charge.amount,
        charge: charge.id,
        user: {
          connect: {
            id: user.id
          }
        },
        items: {
          create: orderItems
        }
      }
    });

    const cartItemsId = user.cart.map(cartItem => cartItem.id);

    await ctx.db.mutation.deleteManyCartItems({
      where: {
        id_in: cartItemsId
      }
    });

    // clear existing cart so that once order is completed no items would on the cart

    return order;
  },
  async updateQuantity(parent, args, ctx, info) {
    if (!ctx.request.userId) {
      throw new Error("You must be logged in!");
    }

    const existingCartItem = await ctx.db.query.cartItem({
      where: {
        id: args.id
      }
    });

    if (existingCartItem.quantity !== 0) {
      return await ctx.db.mutation.updateCartItem({
        where: {
          id: existingCartItem.id
        },
        data: {
          quantity: existingCartItem.quantity - 1
        }
      });
    }

    return existingCartItem;
  },

  async requestReset(parent, args, ctx, info) {
    const user = await ctx.db.query.user({
      where: {
        email: args.email
      }
    });

    if (!user) {
      throw new Error("User with such an email does not exist");
    }

    // generate reset token

    const randomBytesPromisified = promisify(randomBytes);
    const resetToken = (await randomBytesPromisified(20)).toString("hex");
    // add resetTokenExpiryTime
    const resetTokenExpiry = Date.now() + 3600000;

    // update the user with resetToken and expiry

    const updatedUser = await ctx.db.mutation.updateUser({
      where: {
        email: args.email
      },
      data: {
        resetToken,
        resetTokenExpiry
      }
    });

    const message = {
      from: "tracky-tronics@gmail.com",
      to: user.email,
      subject: "Password Reset Request",
      html: makeNiceEmail(`Your Password Reset Token is here!
      \n\n
      <a href="${process.env.FRONTEND_URL}/reset?resetToken=${resetToken}">Click Here to Reset</a>`)
    };

    const mailResponse = await transport.sendMail(message);

    return { message: "Thanks!" };
  },

  async resetPassword(parent, args, ctx, info) {
    if (args.password !== args.confirmPassword) {
      throw new Error("Passwords do not match!");
    }

    const [user] = await ctx.db.query.users({
      where: {
        resetToken: args.resetToken,
        resetTokenExpiry_gte: Date.now() - 3600000
      }
    });

    if (!user) {
      throw new Error("Token is invalid or expired!");
    }

    const password = await bcrypt.hash(args.password, 12);

    const updatedUser = await ctx.db.mutation.updateUser({
      where: {
        email: user.email
      },
      data: {
        password,
        resetToken: null,
        resetTokenExpiry: null
      }
    });

    const token = jwt.sign({ userId: user.id }, process.env.APP_SECRET);
    // We set the jwt as a cookie on the response
    ctx.response.cookie("token", token, {
      httpOnly: true,
      maxAge: 1000 * 60 * 60 * 24 * 365
    });

    return updatedUser;
  },
  async contactUsRequest(parent, args, ctx, info) {
    const message = {
      from: args.email,
      to: `${process.env.SUPPORT_EMAIL}`,
      subject: "Customer Contacted",
      html: makeNiceEmail(`${args.message}
      \n\n
      <p>${args.phone}</p>`)
    };

    const mailResponse = await transport.sendMail(message);

    return {
      message: "Your request has been sent! Our team will contact you shortly."
    };
  },
  async addReview(parent, { itemId, text, rating }, ctx, info) {
    if (!ctx.request.userId) {
      throw new Error("You must be logged in to write a review!");
    }

    return await ctx.db.mutation.createReview({
      data: {
        author: {
          connect: {
            id: ctx.request.userId
          }
        },
        item: {
          connect: {
            id: itemId
          }
        },
        text,
        rating
      }
    });
  }
};

module.exports = Mutation;
