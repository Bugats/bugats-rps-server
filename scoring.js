// ZOLE scoring tables (classic LV rules).
"use strict";

const CONTRACT_TAKE = "ŅEMT GALDU";
const CONTRACT_ZOLE = "ZOLE";
const CONTRACT_MAZA = "MAZĀ";

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

/**
 * MAZĀ ZOLE (3 spēlētāji, klasiskā tabula no lietotāja):
 * - deklarētājs ("lielais") uzvar tikai ar bezstiķi => payEach +6 no katra
 * - citādi zaudē => payEach -7 katram
 */
function computeMazaPayEach(bigTricks) {
  const bTr = Number(bigTricks || 0) || 0;
  const bigWins = bTr === 0;
  if (bigWins) return { bigWins, payEachSigned: +6, status: "UZVAR (BEZSTIĶIS)" };
  return { bigWins, payEachSigned: -7, status: "ZAUDĒ" };
}

/**
 * GALDIŅŠ (visi GARĀM) — tabula no lietotāja:
 * - zaudētājs: -6
 * - pārējie: +2 katrs
 *
 * Ja ir pilnīgs neizšķirts pēc stiķiem un acīm, atgriež null (0 visiem).
 */
function computeGaldinsDeltas(tricks, eyes, pay = 2) {
  const tr = Array.isArray(tricks) ? tricks.map((x) => Number(x || 0) || 0) : [0, 0, 0];
  const ey = Array.isArray(eyes) ? eyes.map((x) => Number(x || 0) || 0) : [0, 0, 0];
  const maxTr = Math.max(...tr);
  let losers = [0, 1, 2].filter((s) => tr[s] === maxTr);

  if (losers.length > 1) {
    const maxEyesAmong = Math.max(...losers.map((s) => ey[s]));
    losers = losers.filter((s) => ey[s] === maxEyesAmong);
  }

  if (losers.length !== 1) return null; // neizšķirts
  const L = losers[0];
  const p = Number(pay || 0) || 0;
  const deltas = [0, 0, 0];
  deltas[L] = -3 * p; // -6, ja p=2
  for (let s = 0; s < 3; s++) if (s !== L) deltas[s] = +p;
  return { deltas, loserSeat: L };
}

module.exports = { computePayEachClassic, computeMazaPayEach, computeGaldinsDeltas, CONTRACT_TAKE, CONTRACT_ZOLE, CONTRACT_MAZA };

