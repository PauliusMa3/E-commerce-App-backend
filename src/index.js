require("dotenv").config({ path: "variables.env" });
const createServer = require("./createServer");
const cookieParser = require("cookie-parser");
const server = createServer();
const jwt = require("jsonwebtoken");

server.express.use(cookieParser());

// Middleware to pass userId on each request.
server.express.use((req, res, next) => {
  const { token } = req.cookies;
  if (token) {
    const { userId } = jwt.verify(token, process.env.APP_SECRET);
    req.userId = userId;
  }

  next();
});

server.start(
  {
    cors: {
      credentials: true,
      origin: process.env.FRONTEND_URL
    }
  },
  deets => {
    console.log(`Server has started on port: ${deets.port}`);
  }
);
