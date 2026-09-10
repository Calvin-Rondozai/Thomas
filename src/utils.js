const crypto = require('crypto');

function makeJobId(url) {
  return crypto.createHash('md5').update(url).digest('hex').slice(0, 12);
}

module.exports = { makeJobId };
