// ZOLE scoring tables (classic LV rules).
"use strict";

const CONTRACT_TAKE = "ŅEMT GALDU";
const CONTRACT_ZOLE = "ZOLE";

/**
 * Classic Zole payEach rules (from each opponent).
 *
 * - TAKE:
 *   - win if bigEyes >= 61
 *   - win pays: +1 each if oppEyes >= 30; +2 each if oppEyes < 30; +3 each if oppTricks === 0
 *   - loss pays: -2 each if bigEyes < 61; -3 each if bigEyes < 31; -4 each if bigTricks === 0
 *
 * - ZOLE:
 *   - win if bigEyes >= 61
 *   - win pays: +5 each; +6 each if bigEyes >= 91; +7 each if bigTricks === 8
 *   - loss pays: -6 each; -7 each if bigEyes < 31; -8 each if bigTricks === 0
 */
function computePayEachClassic(contract, bigEyes, bigTricks) {
  const c = String(contract || "");
  const bEyes = Number(bigEyes || 0) || 0;
  const bTr = Number(bigTricks || 0) || 0;

  const oppEyes = 120 - bEyes;
  const oppTricks = 8 - bTr;

  if (c !== CONTRACT_TAKE && c !== CONTRACT_ZOLE) return null;

  const bigWins = bEyes >= 61;

  if (c === CONTRACT_TAKE) {
    if (bigWins) {
      if (oppTricks === 0) return { bigWins, payEachSigned: +3, status: "UZVAR BEZTUKŠĀ" };
      if (oppEyes < 30) return { bigWins, payEachSigned: +2, status: "UZVAR JAŅOS" };
      return { bigWins, payEachSigned: +1, status: "UZVAR" };
    }
    // lose
    if (bTr === 0) return { bigWins, payEachSigned: -4, status: "ZAUDĒ BEZTUKŠĀ" };
    if (bEyes < 31) return { bigWins, payEachSigned: -3, status: "ZAUDĒ JAŅOS" };
    return { bigWins, payEachSigned: -2, status: "ZAUDĒ" };
  }

  // ZOLE
  if (bigWins) {
    if (bTr === 8) return { bigWins, payEachSigned: +7, status: "UZVAR BEZTUKŠĀ" };
    if (bEyes >= 91) return { bigWins, payEachSigned: +6, status: "UZVAR JAŅOS" };
    return { bigWins, payEachSigned: +5, status: "UZVAR" };
  }
  // lose
  if (bTr === 0) return { bigWins, payEachSigned: -8, status: "ZAUDĒ BEZTUKŠĀ" };
  if (bEyes < 31) return { bigWins, payEachSigned: -7, status: "ZAUDĒ JAŅOS" };
  return { bigWins, payEachSigned: -6, status: "ZAUDĒ" };
}

module.exports = { computePayEachClassic };

