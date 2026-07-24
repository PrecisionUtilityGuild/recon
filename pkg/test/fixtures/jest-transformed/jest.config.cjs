module.exports = {
  testMatch: ["<rootDir>/test/**/*.test.js"],
  transform: {
    "^.+\\.ts$": ["babel-jest", { configFile: "./babel.config.cjs" }]
  }
};
