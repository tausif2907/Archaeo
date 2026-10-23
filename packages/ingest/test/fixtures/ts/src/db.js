const store = require("./store.json");

async function findUser(id) {
  return store.users.find((u) => u.id === id);
}

module.exports = { findUser };
