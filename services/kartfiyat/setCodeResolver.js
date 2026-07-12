require('dotenv').config();

const { normalizeGameId } = require('../ikas/taxonomy');
const { resolveSet } = require('./setRegistry');
const { resolveOnePieceSet } = require('./onepieceSetRegistry');

async function resolveSetForGame(setCode, game = 'pokemon') {
  const gameId = normalizeGameId(game);
  if (gameId === 'onepiece') {
    return resolveOnePieceSet(setCode);
  }
  return resolveSet(setCode);
}

module.exports = {
  resolveSetForGame,
};
