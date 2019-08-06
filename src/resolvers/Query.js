const { forwardTo } = require("prisma-binding");

const Query = {
  items: forwardTo("db"),
  item: forwardTo("db"),
  itemsConnection: forwardTo("db"),
  async users(parent, args, ctx, info) {
    return await ctx.db.query.users({}, info);
  },

  async me(parent, args, ctx, info) {
    if (!ctx.request.userId) {
      return null;
    }

    const user = await ctx.db.query.user(
      {
        where: {
          id: ctx.request.userId
        }
      },
      info
    );

    return user;
  },

  async order(parent, args, ctx, info) {
    if (!ctx.request.userId) {
      throw new Error("You must be signed in to see the orders");
    }

    const order = await ctx.db.query.order(
      {
        where: {
          id: args.id
        }
      },
      info
    );

    const ownsOrder = order.user.id === ctx.request.userId;

    if (!ownsOrder) {
      throw new Error("You cannot see this order!");
    }

    return order;
  },
  async orders(parent, args, ctx, info) {
    if (!ctx.request.userId) {
      throw new Error("You must be signed in to see Orders!");
    }
    const orders = await ctx.db.query.orders(
      {
        where: {
          user: {
            id: ctx.request.userId
          }
        }
      },
      info
    );
    return orders;
  }
};

module.exports = Query;
