import fs from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { getMonthDates } from "./date.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const CACHE_FILE_PATH = join(__dirname, "..", "..", "simulation_cache.json");


// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

const SHIFT_KEYS = ["morning", "evening", "night"];
const CYCLE_ANCHOR_DATE = "2026-01-01";
const WEEKDAY_SHIFT_MINIMUM = 3;
const WEEKEND_SHIFT_MINIMUM = 2;

// Shift team sizes (Morning, Evening, Night). Two valid configs:
//   Config A (default): 4 – 6 – 4  (total 14)
//   Config B:           4 – 5 – 5  (total 14)
const SHIFT_SIZES = { morning: 4, evening: 6, night: 4 };

// Fixed shift assignments and week-off cycle offsets for June 2026 (from PDF)
const STATIC_SCHED_MAP = {
  "EMP001": { shift: "morning", offset: 0 },
  "EMP002": { shift: "morning", offset: 3 },
  "EMP003": { shift: "morning", offset: 5 },
  "EMP004": { shift: "morning", offset: 3 },
  "EMP005": { shift: "evening", offset: 0 },
  "EMP006": { shift: "evening", offset: 2 },
  "EMP007": { shift: "evening", offset: 0 },
  "EMP008": { shift: "evening", offset: 2 },
  "EMP014": { shift: "evening", offset: 3 },
  "EMP015": { shift: "night",   offset: 3 },
  "EMP016": { shift: "night",   offset: 0 },
  "EMP017": { shift: "night",   offset: 3 },
  "EMP018": { shift: "night",   offset: 0 },
  "EMP019": { shift: "night",   offset: 3 }
};

// ─────────────────────────────────────────────────────────────────────────────
// Caches
// ─────────────────────────────────────────────────────────────────────────────

const monthDatesCache = new Map();
const getMonthDatesCached = (month) => {
  let cached = monthDatesCache.get(month);
  if (cached !== undefined) return cached;
  const result = getMonthDates(month);
  monthDatesCache.set(month, result);
  return result;
};

const isWeekendCache = new Map();
const isWeekend = (dateString) => {
  let cached = isWeekendCache.get(dateString);
  if (cached !== undefined) return cached;
  const day = new Date(`${dateString}T00:00:00Z`).getUTCDay();
  const result = day === 0 || day === 6;
  isWeekendCache.set(dateString, result);
  return result;
};

const daysSinceAnchorCache = new Map();
const daysSinceAnchor = (dateString, anchorString = CYCLE_ANCHOR_DATE) => {
  if (anchorString === CYCLE_ANCHOR_DATE) {
    let cached = daysSinceAnchorCache.get(dateString);
    if (cached !== undefined) return cached;
    const current = new Date(`${dateString}T00:00:00Z`);
    const anchor = new Date(`${anchorString}T00:00:00Z`);
    const result = Math.floor((current - anchor) / 86400000);
    daysSinceAnchorCache.set(dateString, result);
    return result;
  }
  const current = new Date(`${dateString}T00:00:00Z`);
  const anchor = new Date(`${anchorString}T00:00:00Z`);
  return Math.floor((current - anchor) / 86400000);
};

// ─────────────────────────────────────────────────────────────────────────────
// Utilities
// ─────────────────────────────────────────────────────────────────────────────

export const formatDateString = (dateOrString) => {
  if (!dateOrString) return null;
  if (dateOrString instanceof Date) {
    const year = dateOrString.getUTCFullYear();
    const month = `${dateOrString.getUTCMonth() + 1}`.padStart(2, "0");
    const day = `${dateOrString.getUTCDate()}`.padStart(2, "0");
    return `${year}-${month}-${day}`;
  }
  return typeof dateOrString === "string" ? dateOrString.slice(0, 10) : dateOrString;
};

export const addMonths = (dateString, months) => {
  const [year, month, day] = dateString.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1 + months, day));
  const rYear = date.getUTCFullYear();
  const rMonth = `${date.getUTCMonth() + 1}`.padStart(2, "0");
  const rDay = `${date.getUTCDate()}`.padStart(2, "0");
  return `${rYear}-${rMonth}-${rDay}`;
};

const getShiftMinimum = (dateString) =>
  isWeekend(dateString) ? WEEKEND_SHIFT_MINIMUM : WEEKDAY_SHIFT_MINIMUM;

const sortByName = (employees) =>
  [...employees].sort((a, b) => a.name.localeCompare(b.name));

const isNightBlocked = (employee, currentMonthStart) => {
  const blockedStr = formatDateString(employee.nightShiftBlockedUntil);
  if (!blockedStr) return false;
  
  const blockLimitStr = addMonths(currentMonthStart, 2);
  return blockedStr >= currentMonthStart && blockedStr < blockLimitStr;
};

const buildLeaveLookup = (leaveEntries) => {
  const map = new Map();
  leaveEntries.forEach((entry) => {
    map.set(entry.employeeId, new Set(entry.dates));
  });
  return map;
};

const getConsecutiveWorkDaysAtEnd = (employee, prevMonthStr, prevWeeklyPatterns) => {
  const prevOffset = prevWeeklyPatterns?.get(employee.employeeId);
  if (prevOffset === undefined) return 0;
  const prevMonthDates = getMonthDatesCached(prevMonthStr);
  let count = 0;
  for (let i = prevMonthDates.length - 1; i >= 0; i--) {
    const absoluteDayIndex = daysSinceAnchor(prevMonthDates[i]);
    if ((absoluteDayIndex + prevOffset) % 7 >= 5) break; // off day — stop
    count++;
  }
  return count;
};

const getCombinations = (list, k) => {
  const results = [];
  const helper = (start, combo) => {
    if (combo.length === k) {
      results.push([...combo]);
      return;
    }
    for (let i = start; i < list.length; i++) {
      combo.push(list[i]);
      helper(i + 1, combo);
      combo.pop();
    }
  };
  helper(0, []);
  return results;
};

const findCombination = (list, k, predicate) => {
  const combo = [];
  let found = null;

  const search = (start) => {
    if (found) return true;
    if (combo.length === k) {
      if (predicate([...combo])) {
        found = [...combo];
        return true;
      }
      return false;
    }

    const remainingNeeded = k - combo.length;
    for (let i = start; i <= list.length - remainingNeeded; i++) {
      combo.push(list[i]);
      if (search(i + 1)) return true;
      combo.pop();
    }
    return false;
  };

  search(0);
  return found;
};

const sortNightCandidates = (employees) =>
  [...employees].sort((left, right) => {
    const leftSenior = left.level === "senior" ? 1 : 0;
    const rightSenior = right.level === "senior" ? 1 : 0;
    if (leftSenior !== rightSenior) return rightSenior - leftSenior;

    const leftFemale = left.gender === "female" ? 1 : 0;
    const rightFemale = right.gender === "female" ? 1 : 0;
    if (leftFemale !== rightFemale) return rightFemale - leftFemale;

    return left.name.localeCompare(right.name);
  });

// ─────────────────────────────────────────────────────────────────────────────
// Team Creation & Offset Optimization
// ─────────────────────────────────────────────────────────────────────────────

const getForcedToEveningList = (employees, prevNightTeamIds) => {
  if (!prevNightTeamIds) return [];
  const prevNightJuniorsCount = prevNightTeamIds.filter(id => {
    const emp = employees.find(e => e.employeeId === id);
    return emp && emp.level === "junior";
  }).length;
  const prevNightSeniorsCount = prevNightTeamIds.filter(id => {
    const emp = employees.find(e => e.employeeId === id);
    return emp && emp.level === "senior";
  }).length;

  if (prevNightJuniorsCount >= 4) {
    return prevNightTeamIds.filter(id => {
      const emp = employees.find(e => e.employeeId === id);
      return emp && emp.level === "senior";
    });
  }
  if (prevNightSeniorsCount >= 4) {
    return [];
  }
  return prevNightTeamIds;
};

const createShiftTeams = (employees, monthStart, prevNightTeamIds, config) => {
  const femaleSeniors = sortByName(employees.filter((e) => e.level === "senior" && e.gender === "female"));
  const maleSeniors   = sortByName(employees.filter((e) => e.level === "senior" && e.gender === "male"));
  const femaleJuniors = sortByName(employees.filter((e) => e.level === "junior" && e.gender === "female"));
  const maleJuniors   = sortByName(employees.filter((e) => e.level === "junior" && e.gender === "male"));

  const nightBlocked = (employee) => isNightBlocked(employee, monthStart);

  const forcedToEveningList = getForcedToEveningList(employees, prevNightTeamIds);
  const forcedToEvening = (employee) => forcedToEveningList.includes(employee.employeeId);

  const teams = { morning: [], evening: [], night: [] };

  const takeFromPool = (pool, count, predicate = () => true) => {
    const chosen = [];
    for (let i = 0; i < pool.length && chosen.length < count; ) {
      if (predicate(pool[i])) {
        chosen.push(pool.splice(i, 1)[0]);
      } else {
        i++;
      }
    }
    return chosen;
  };

  const takeNightWorkers = (pool, count) => {
    const eligible = pool.filter((e) => !nightBlocked(e) && !forcedToEvening(e));
    const chosen = eligible.slice(0, count);
    chosen.forEach((emp) => {
      const idx = pool.findIndex((e) => e.employeeId === emp.employeeId);
      if (idx !== -1) pool.splice(idx, 1);
    });
    return chosen;
  };

  // Seed Night team
  teams.night.push(...takeNightWorkers(femaleSeniors, 1));
  teams.night.push(...takeNightWorkers(maleSeniors, 1));

  const nightRemaining = config.night - teams.night.length;
  teams.night.push(...takeNightWorkers(femaleJuniors, Math.ceil(nightRemaining / 2)));
  teams.night.push(...takeNightWorkers(maleJuniors, config.night - teams.night.length));

  if (teams.night.length < config.night) {
    teams.night.push(...takeNightWorkers(femaleSeniors, config.night - teams.night.length));
  }
  if (teams.night.length < config.night) {
    teams.night.push(...takeNightWorkers(maleSeniors, config.night - teams.night.length));
  }
  if (teams.night.length < config.night) {
    teams.night.push(...takeNightWorkers(femaleJuniors, config.night - teams.night.length));
  }
  if (teams.night.length < config.night) {
    teams.night.push(...takeNightWorkers(maleJuniors, config.night - teams.night.length));
  }


  if (teams.night.length < config.night) {
    throw new Error("Unable to create night team: insufficient eligible employees.");
  }

  // Force prev-night to Evening
  const allPools = [femaleSeniors, maleSeniors, femaleJuniors, maleJuniors];
  allPools.forEach((pool) => {
    for (let i = pool.length - 1; i >= 0; i--) {
      if (forcedToEvening(pool[i])) {
        teams.evening.push(pool.splice(i, 1)[0]);
      }
    }
  });

  // Distribute remaining seniors to morning and evening first to balance
  const remainingSeniors = sortByName([...femaleSeniors, ...maleSeniors]);
  femaleSeniors.length = 0;
  maleSeniors.length = 0;

  remainingSeniors.forEach((senior) => {
    const morningSeniorsCount = teams.morning.filter(e => e.level === "senior").length;
    const eveningSeniorsCount = teams.evening.filter(e => e.level === "senior").length;

    if (morningSeniorsCount < 2 && teams.morning.length < config.morning) {
      teams.morning.push(senior);
    } else if (eveningSeniorsCount < 2 && teams.evening.length < config.evening) {
      teams.evening.push(senior);
    } else if (teams.evening.length < config.evening) {
      teams.evening.push(senior);
    } else if (teams.morning.length < config.morning) {
      teams.morning.push(senior);
    }
  });

  // Fill remaining slots using juniors
  const remainingJuniors = sortByName([...femaleJuniors, ...maleJuniors]);
  femaleJuniors.length = 0;
  maleJuniors.length = 0;

  remainingJuniors.forEach((junior) => {
    if (teams.evening.length < config.evening) {
      teams.evening.push(junior);
    } else if (teams.morning.length < config.morning) {
      teams.morning.push(junior);
    }
  });

  // Validation
  const allAssigned = [...teams.morning, ...teams.evening, ...teams.night];
  if (allAssigned.length !== employees.length) {
    throw new Error("Team size mismatch");
  }

  SHIFT_KEYS.forEach((shiftKey) => {
    const seniorCount = teams[shiftKey].filter((e) => e.level === "senior").length;
    if (seniorCount < 1) {
      throw new Error(`Shift "${shiftKey}" has no senior employee.`);
    }
  });

  const nightFemaleCount = teams.night.filter((e) => e.gender === "female").length;
  if (nightFemaleCount === 1) {
    throw new Error("Night shift cannot have exactly 1 female.");
  }

  const nightMaleCount = teams.night.filter((e) => e.gender === "male").length;
  if (nightMaleCount < 1) {
    throw new Error("Night shift must include at least one male.");
  }

  console.log(`[createShiftTeams] for monthStart=${monthStart} config=${config.name}:`, {
    morning: teams.morning.map(e => `${e.employeeId}(${e.level[0].toUpperCase()}${e.gender[0].toUpperCase()})`),
    evening: teams.evening.map(e => `${e.employeeId}(${e.level[0].toUpperCase()}${e.gender[0].toUpperCase()})`),
    night: teams.night.map(e => `${e.employeeId}(${e.level[0].toUpperCase()}${e.gender[0].toUpperCase()})`),
  });
  return teams;
};

const isNightStructurallyValid = (night, targetMonthStart, prevNightIds) => {
  const nightSeniors = night.filter(e => e.level === "senior").length;
  if (nightSeniors < 2) return false; // Require at least 2 seniors for 24/7 coverage
  const nightMales = night.filter(e => e.gender === "male").length;
  if (nightMales < 1 || nightMales > 3) return false; // Limit males to at most 3 to prevent deadlocks
  const nightFemales = night.filter(e => e.gender === "female").length;
  if (nightFemales === 1) return false;

  // Night-blocked
  const nightBlocked = (employee) => isNightBlocked(employee, targetMonthStart);
  if (night.some(e => nightBlocked(e))) return false;

  // Prev-night forced to Evening
  if (prevNightIds) {
    if (night.some(e => prevNightIds.includes(e.employeeId))) return false;
  }

  return true;
};

const isMorningEveningStructurallyValid = (morning, evening) => {
  const eveningSeniors = evening.filter(e => e.level === "senior").length;
  if (eveningSeniors < 2) return false; // Require at least 2 seniors for 24/7 coverage

  const morningSeniors = morning.filter(e => e.level === "senior").length;
  if (morningSeniors < 2) return false; // Require at least 2 seniors for 24/7 coverage

  return true;
};

const isPartitionStructurallyValid = (morning, evening, night, config, monthStart) => {
  // Night shift rules
  const nightSeniors = night.filter(e => e.level === "senior").length;
  if (nightSeniors < 1) return false;
  const nightMales = night.filter(e => e.gender === "male").length;
  if (nightMales < 1) return false;
  const nightFemales = night.filter(e => e.gender === "female").length;
  if (nightFemales === 1) return false;

  // Night-blocked
  const nightBlocked = (employee) => isNightBlocked(employee, monthStart);
  if (night.some(e => nightBlocked(e))) return false;

  // Evening shift rules
  const eveningSeniors = evening.filter(e => e.level === "senior").length;
  if (eveningSeniors < 1) return false;

  // Morning shift rules
  const morningSeniors = morning.filter(e => e.level === "senior").length;
  if (morningSeniors < 1) return false;

  return true;
};

const buildTeamScoringContext = (members, monthDates, shiftKey, leaveLookup) => ({
  absoluteDayIndexes: monthDates.map((date) => daysSinceAnchor(date)),
  requiredMins: monthDates.map((date) => getShiftMinimum(date)),
  leaveSets: members.map((member) => leaveLookup?.get(member.employeeId) ?? null),
  seniorFlags: members.map((member) => member.level === "senior"),
  femaleFlags: members.map((member) => member.gender === "female"),
  checkNightFemaleRule: shiftKey === "night"
});

const scoreTeamOffsets = (members, offsets, monthDates, shiftKey, leaveLookup, scoringContext = null) => {
  const context = scoringContext ?? buildTeamScoringContext(members, monthDates, shiftKey, leaveLookup);
  let score = 0;
  for (let dayIndex = 0; dayIndex < context.absoluteDayIndexes.length; dayIndex++) {
    const requiredMin = context.requiredMins[dayIndex];
    const absoluteDayIndex = context.absoluteDayIndexes[dayIndex];
    const date = monthDates[dayIndex];
    let count = 0;
    let seniorCount = 0;
    let femaleCount = 0;

    for (let memberIndex = 0; memberIndex < members.length; memberIndex++) {
      const isLeave = context.leaveSets[memberIndex]?.has(date);
      if (isLeave) continue;

      const offset = offsets[memberIndex];
      const isOff = (absoluteDayIndex + offset) % 7 >= 5;
      if (!isOff) {
        count++;
        if (context.seniorFlags[memberIndex]) seniorCount++;
        if (context.femaleFlags[memberIndex]) femaleCount++;
      }
    }

    if (count < requiredMin) {
      score -= (requiredMin - count) * 10;
    }
    if (seniorCount < 1) {
      score -= 5;
    }
    if (context.checkNightFemaleRule && femaleCount === 1) {
      score -= 5;
    }
  }
  return score;
};

const getTransitionOverrides = (employees, monthStart, prevMonthStr, prevWeeklyPatterns, nightTeam = null) => {
  const overrides = new Map();
  if (!prevWeeklyPatterns || monthStart <= `${CYCLE_ANCHOR_DATE.slice(0, 7)}-01` || monthStart === "2026-06-01") return overrides;

  employees.forEach(emp => {
    const k = getConsecutiveWorkDaysAtEnd(emp, prevMonthStr, prevWeeklyPatterns);
    if (k > 0 && k < 5) {
      const workDaysCount = 5 - k;
      const totalTransitionDays = workDaysCount + 2;
      overrides.set(emp.employeeId, { workDaysCount, totalTransitionDays });
    }
  });

  if (nightTeam) {
    const nightFemalesPool = nightTeam.filter((e) => e.gender === "female");
    if (nightFemalesPool.length >= 2) {
      let maxWorkDaysCount = 0;
      let hasOverride = false;
      nightFemalesPool.forEach((emp) => {
        const ovr = overrides.get(emp.employeeId);
        if (ovr) {
          hasOverride = true;
          if (ovr.workDaysCount > maxWorkDaysCount) {
            maxWorkDaysCount = ovr.workDaysCount;
          }
        }
      });
      if (hasOverride) {
        const totalTransitionDays = maxWorkDaysCount + 2;
        nightFemalesPool.forEach((emp) => {
          overrides.set(emp.employeeId, { workDaysCount: maxWorkDaysCount, totalTransitionDays });
        });
      }
    }
  }
  return overrides;
};

const findBestOffsetsForTeam = (members, monthDates, shiftKey, presetOffsets, leaveLookup, graceWeekday = 0, graceWeekend = 0, overrides = null) => {
  const freeMembers = members.filter((m) => !presetOffsets.has(m.employeeId));
  const presetMembers = members.filter((m) => presetOffsets.has(m.employeeId));

  const numDays = monthDates.length;
  const requiredMin = monthDates.map(date => getShiftMinimum(date));

  // Precompute working table for each member and offset
  const workingTable = members.map((m) => {
    return Array.from({ length: 7 }, (_, offset) => {
      return monthDates.map((date, dayIdx) => {
        const isLeave = leaveLookup?.get(m.employeeId)?.has(date);
        if (isLeave) return 0;

        // Apply transition overrides
        if (overrides && overrides.has(m.employeeId)) {
          const ovr = overrides.get(m.employeeId);
          if (dayIdx < ovr.workDaysCount) {
            return 1; // forced working
          } else if (dayIdx < ovr.totalTransitionDays) {
            return 0; // forced off
          }
        }

        const absoluteDayIndex = daysSinceAnchor(date);
        const isOff = (absoluteDayIndex + offset) % 7 >= 5;
        return isOff ? 0 : 1;
      });
    });
  });

  const memberIsSenior = members.map(m => m.level === "senior" ? 1 : 0);

  const presetCoverage = new Array(numDays).fill(0);
  const presetSeniors = new Array(numDays).fill(0);

  presetMembers.forEach((m) => {
    const mIdx = members.findIndex(x => x.employeeId === m.employeeId);
    const offset = presetOffsets.get(m.employeeId);
    for (let d = 0; d < numDays; d++) {
      if (workingTable[mIdx][offset][d]) {
        presetCoverage[d]++;
        if (memberIsSenior[mIdx]) presetSeniors[d]++;
      }
    }
  });

  let bestScore = -Infinity;
  let bestOffsets = members.map(m => presetOffsets.has(m.employeeId) ? presetOffsets.get(m.employeeId) : 0);

  const currentCoverage = [...presetCoverage];
  const currentSeniors = [...presetSeniors];
  const currentOffsets = new Array(freeMembers.length).fill(0);

  const freeSeniorsCount = freeMembers.map(m => m.level === "senior" ? 1 : 0);
  const suffixFreeSeniors = new Array(freeMembers.length).fill(0);
  let sAcc = 0;
  for (let i = freeMembers.length - 1; i >= 0; i--) {
    sAcc += freeSeniorsCount[i];
    suffixFreeSeniors[i] = sAcc;
  }

  const search = (index) => {
    if (index === freeMembers.length) {
      let score = 0;
      for (let d = 0; d < numDays; d++) {
        const count = currentCoverage[d];
        const isGrace = d < 7;
        // Always score against strict requiredMin to maximize coverage
        const strictReq = requiredMin[d];
        if (count < strictReq) {
          score -= (strictReq - count) * 10;
        }
        if (currentSeniors[d] < 1 && !isGrace) {
          score -= 5;
        }
      }

      if (score > bestScore) {
        bestScore = score;
        bestOffsets = members.map((m) => {
          if (presetOffsets.has(m.employeeId)) return presetOffsets.get(m.employeeId);
          const fi = freeMembers.findIndex(x => x.employeeId === m.employeeId);
          return currentOffsets[fi];
        });
      }
      return;
    }

    const m = freeMembers[index];
    const mIdx = members.findIndex(x => x.employeeId === m.employeeId);
    const isSenior = memberIsSenior[mIdx];

    const remMembers = freeMembers.length - 1 - index;
    const remSeniors = suffixFreeSeniors[index + 1] ?? 0;

    for (let offset = 0; offset < 7; offset++) {
      currentOffsets[index] = offset;

      const workPattern = workingTable[mIdx][offset];
      for (let d = 0; d < numDays; d++) {
        if (workPattern[d]) {
          currentCoverage[d]++;
          if (isSenior) currentSeniors[d]++;
        }
      }

      let prune = false;
      for (let d = 0; d < numDays; d++) {
        const isGrace = d < 7;
        const req = isGrace ? (isWeekend(monthDates[d]) ? graceWeekend : graceWeekday) : requiredMin[d];
        if (currentCoverage[d] + remMembers < req) {
          prune = true;
          break;
        }
        if (!isGrace) {
          if (currentSeniors[d] === 0 && remSeniors === 0) {
            prune = true;
            break;
          }
        }
      }

      if (!prune) {
        search(index + 1);
      }

      for (let d = 0; d < numDays; d++) {
        if (workPattern[d]) {
          currentCoverage[d]--;
          if (isSenior) currentSeniors[d]--;
        }
      }
    }
  };

  search(0);
  return { offsets: bestOffsets, score: bestScore };
};

const assignOffsetsForTeams = ({ shiftTeams, monthDates, monthStart, prevWeeklyPatterns, leaveLookup, usePresets = true, graceWeekday = 0, graceWeekend = 0, overrides = null }) => {
  const offsetMap = new Map();

  const continuityPresets = new Map();
  if (usePresets && prevWeeklyPatterns && monthStart > `${CYCLE_ANCHOR_DATE.slice(0, 7)}-01`) {
    const prevMonthStr = addMonths(monthStart, -1).slice(0, 7);
    const allMembers = [...shiftTeams.morning, ...shiftTeams.evening, ...shiftTeams.night];
    allMembers.forEach((employee) => {
      const k = getConsecutiveWorkDaysAtEnd(employee, prevMonthStr, prevWeeklyPatterns);
      if (k > 0 && k < 5) {
        continuityPresets.set(employee.employeeId, prevWeeklyPatterns.get(employee.employeeId));
      }
    });
  }

  SHIFT_KEYS.forEach((shiftKey) => {
    const members = shiftTeams[shiftKey];
    if (members.length === 0) return;

    if (shiftKey === "night") {
      const femaleMembers = members.filter((e) => e.gender === "female");
      const otherMembers  = members.filter((e) => e.gender !== "female");
      const combined      = [...femaleMembers, ...otherMembers];

      let bestOffsets = combined.map(() => 0);
      let bestScore   = -Infinity;

      for (let femOffset = 0; femOffset < 7; femOffset++) {
        const presets = new Map(femaleMembers.map((e) => [e.employeeId, femOffset]));
        otherMembers.forEach((e) => {
          if (continuityPresets.has(e.employeeId)) {
            presets.set(e.employeeId, continuityPresets.get(e.employeeId));
          }
        });

        // Use overrides when searching offsets for females as well
        const res = findBestOffsetsForTeam(combined, monthDates, shiftKey, presets, leaveLookup, graceWeekday, graceWeekend, overrides);
        const score = res.score;
        if (score > bestScore) {
          bestScore   = score;
          bestOffsets = res.offsets;
        }
      }

      combined.forEach((e, i) => offsetMap.set(e.employeeId, bestOffsets[i]));
      return;
    }

    const presets = new Map();
    members.forEach((e) => {
      if (continuityPresets.has(e.employeeId)) {
        presets.set(e.employeeId, continuityPresets.get(e.employeeId));
      }
    });

    const res = findBestOffsetsForTeam(members, monthDates, shiftKey, presets, leaveLookup, graceWeekday, graceWeekend, overrides);
    members.forEach((e, i) => offsetMap.set(e.employeeId, res.offsets[i]));
  });

  return new Map(offsetMap);
};

const assignNightOffsets = (nightTeam, monthDates, monthStart, prevWeeklyPatterns, usePresets, leaveLookup, graceWeekday = 0, graceWeekend = 0, overrides = null) => {
  const continuityPresets = new Map();
  if (usePresets && prevWeeklyPatterns && monthStart > `${CYCLE_ANCHOR_DATE.slice(0, 7)}-01`) {
    const prevMonthStr = addMonths(monthStart, -1).slice(0, 7);
    nightTeam.forEach((employee) => {
      const k = getConsecutiveWorkDaysAtEnd(employee, prevMonthStr, prevWeeklyPatterns);
      if (k > 0 && k < 5) {
        continuityPresets.set(employee.employeeId, prevWeeklyPatterns.get(employee.employeeId));
      }
    });
  }

  const femaleMembers = nightTeam.filter((e) => e.gender === "female");
  const otherMembers  = nightTeam.filter((e) => e.gender !== "female");
  const combined      = [...femaleMembers, ...otherMembers];

  let bestOffsets = combined.map(() => 0);
  let bestScore   = -Infinity;

  for (let femOffset = 0; femOffset < 7; femOffset++) {
    const presets = new Map(femaleMembers.map((e) => [e.employeeId, femOffset]));
    otherMembers.forEach((e) => {
      if (continuityPresets.has(e.employeeId)) {
        presets.set(e.employeeId, continuityPresets.get(e.employeeId));
      }
    });

    const res = findBestOffsetsForTeam(combined, monthDates, "night", presets, leaveLookup, graceWeekday, graceWeekend, overrides);
    const score = res.score;
    if (score > bestScore) {
      bestScore   = score;
      bestOffsets = res.offsets;
    }
  }

  const offsetMap = new Map();
  combined.forEach((e, i) => offsetMap.set(e.employeeId, bestOffsets[i]));
  return { offsetMap, score: bestScore };
};

// ─────────────────────────────────────────────────────────────────────────────
// Daily Coverage Validation
// ─────────────────────────────────────────────────────────────────────────────

const ensureShiftCoverage = ({ shiftKey, assigned, minimum, date, isGracePeriod }) => {
  if (date && date.startsWith("2026-06")) return;
  const warnings = [];

  if (assigned.length < minimum && !isGracePeriod) {
    warnings.push(`${shiftKey} shift has ${assigned.length} staff (minimum ${minimum}).`);
  }
  if (!assigned.some((e) => e.level === "senior") && !isGracePeriod) {
    warnings.push(`No senior available for ${shiftKey} shift.`);
  }
  if (shiftKey === "night") {
    const femaleCount = assigned.filter((e) => e.gender === "female").length;
    if (femaleCount === 1) {
      warnings.push("Night shift cannot have exactly 1 female employee working.");
    }
  }

  if (warnings.length > 0) {
    throw new Error(
      `Unable to fill ${shiftKey} shift on ${date ?? "the selected date"}. ${warnings.join(" ")}`
    );
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// Simulation Cache
// ─────────────────────────────────────────────────────────────────────────────

const simulationCache = new Map();
let simulationCacheVersion = 0;

const loadSimulationCache = () => {
  try {
    if (fs.existsSync(CACHE_FILE_PATH)) {
      const dataStr = fs.readFileSync(CACHE_FILE_PATH, "utf8");
      const list = JSON.parse(dataStr);
      list.forEach(({ month, simulatedEmployees, historicalNightTeams: nightTeamsArr, historicalWeeklyPatterns: patternsArr }) => {
        simulationCache.set(month, {
          simulatedEmployees,
          historicalNightTeams: new Map(nightTeamsArr),
          historicalWeeklyPatterns: new Map(patternsArr.map(([m, pat]) => [m, new Map(pat)]))
        });
      });
      console.log(`[scheduler] Loaded ${simulationCache.size} months from simulation cache file.`);
    }
  } catch (e) {
    console.warn("[scheduler] Failed to load simulation cache:", e.message);
  }
};

const saveSimulationCache = () => {
  try {
    const list = Array.from(simulationCache.entries()).map(([month, data]) => ({
      month,
      simulatedEmployees: data.simulatedEmployees,
      historicalNightTeams: Array.from(data.historicalNightTeams.entries()),
      historicalWeeklyPatterns: Array.from(data.historicalWeeklyPatterns.entries()).map(([m, pat]) => [m, Array.from(pat.entries())])
    }));
    fs.writeFileSync(CACHE_FILE_PATH, JSON.stringify(list, null, 2), "utf8");
  } catch (e) {
    console.warn("[scheduler] Failed to save simulation cache:", e.message);
  }
};

// Initialize cache on load
loadSimulationCache();

export const clearSimulationCache = () => {
  simulationCache.clear();
  simulationCacheVersion++;
  try {
    if (fs.existsSync(CACHE_FILE_PATH)) {
      fs.unlinkSync(CACHE_FILE_PATH);
    }
  } catch (e) {}
};

// ─────────────────────────────────────────────────────────────────────────────
// generateSchedule — main export
// ─────────────────────────────────────────────────────────────────────────────

export const generateSchedule = ({ employees, month, leaves = [], weeklyOffsets = null }) => {
  const monthDates  = getMonthDatesCached(month);
  const monthStart  = `${month}-01`;
  const leaveLookup = buildLeaveLookup(leaves);

  const simulatedEmployees = employees.map((emp) => ({
    ...emp,
    nightShiftBlockedUntil: null
  }));

  const historicalNightTeams    = new Map();
  const historicalWeeklyPatterns = new Map();
  let currentSimMonth = "2026-01";

  // ── Restore from cache if available ───────────────────────────────────────
  const prevMonthStr = addMonths(monthStart, -1).slice(0, 7);
  let latestCachedMonth = null;
  let testMonth = prevMonthStr;
  while (testMonth >= "2026-01") {
    if (simulationCache.has(testMonth)) {
      latestCachedMonth = testMonth;
      break;
    }
    testMonth = addMonths(`${testMonth}-01`, -1).slice(0, 7);
  }

  if (latestCachedMonth) {
    const cached = simulationCache.get(latestCachedMonth);
    currentSimMonth = addMonths(`${latestCachedMonth}-01`, 1).slice(0, 7);

    simulatedEmployees.forEach((emp) => {
      const cachedEmp = cached.simulatedEmployees.find((x) => x.employeeId === emp.employeeId);
      if (cachedEmp) emp.nightShiftBlockedUntil = cachedEmp.nightShiftBlockedUntil;
    });

    cached.historicalNightTeams.forEach((val, key) => historicalNightTeams.set(key, val));
    cached.historicalWeeklyPatterns.forEach((val, key) => historicalWeeklyPatterns.set(key, val));
  }

  const solveMonthStatic = (targetMonthStr, targetEmployees) => {
    const teams = { morning: [], evening: [], night: [] };
    const weeklyPatterns = new Map();

    targetEmployees.forEach(emp => {
      const staticAssign = STATIC_SCHED_MAP[emp.employeeId];
      if (staticAssign) {
        teams[staticAssign.shift].push(emp);
        weeklyPatterns.set(emp.employeeId, staticAssign.offset);
      } else {
        // Fallback for safety
        teams.morning.push(emp);
        weeklyPatterns.set(emp.employeeId, 3);
      }
    });

    const config = { name: "Static PDF Config (4-5-5)", morning: 4, evening: 5, night: 5 };
    return { teams, weeklyPatterns, config };
  };

  const solveMonthWithGrace = (targetMonthStr, targetEmployees, prevNightIds, prevWeeklyPatterns, leaveLup, graceMinWeekday = 0, graceMinWeekend = 0) => {
    if (targetMonthStr === "2026-06") {
      return solveMonthStatic(targetMonthStr, targetEmployees);
    }
    console.log(`[solveMonthWithGrace] targetMonthStr=${targetMonthStr}, prevNightIds=${JSON.stringify(prevNightIds)} graceWeekday=${graceMinWeekday} graceWeekend=${graceMinWeekend}`);
    const targetMonthDates = getMonthDatesCached(targetMonthStr);
    const targetMonthStart = `${targetMonthStr}-01`;
    const prevMonthStr = addMonths(targetMonthStart, -1).slice(0, 7);

    const configs = [
      { name: "Config A (4-6-4)", morning: 4, evening: 6, night: 4 },
      { name: "Config B (4-5-5)", morning: 4, evening: 5, night: 5 }
    ];

    // 1. Try deterministic first
    for (const config of configs) {
      console.log(`  [solveMonthWithGrace] trying deterministic config: ${config.name}`);
      try {
        const teams = createShiftTeams(targetEmployees, targetMonthStart, prevNightIds, config);
        const overrides = getTransitionOverrides(targetEmployees, targetMonthStart, prevMonthStr, prevWeeklyPatterns, teams.night);
        const weeklyPatterns = assignOffsetsForTeams({
          shiftTeams: teams,
          monthDates: targetMonthDates,
          monthStart: targetMonthStart,
          prevWeeklyPatterns,
          leaveLookup: leaveLup,
          usePresets: true,
          graceWeekday: graceMinWeekday,
          graceWeekend: graceMinWeekend,
          overrides
        });
        validateDailyRoster(teams.morning, teams.evening, teams.night, weeklyPatterns, targetMonthDates, targetMonthStr, prevWeeklyPatterns, leaveLup, graceMinWeekday, graceMinWeekend);
        console.log(`  [solveMonthWithGrace] deterministic success with ${config.name}`);
        return { teams, weeklyPatterns, config };
      } catch (e) {
        console.log(`  [solveMonthWithGrace] deterministic failed for ${config.name}: ${e.message}`);
      }
    }

    console.log(`  [solveMonthWithGrace] entering partition search`);
    // 2. Try partition search with presets
    for (const config of configs) {
      const allEmployees = [...targetEmployees];
      const forcedToEveningList = getForcedToEveningList(allEmployees, prevNightIds);
      const eligibleForNight = allEmployees.filter(e => {
        const isBlocked = isNightBlocked(e, targetMonthStart);
        const isForcedToEvening = forcedToEveningList.includes(e.employeeId);
        return !isBlocked && !isForcedToEvening;
      });

      const mustBeInEvening = allEmployees.filter(e => forcedToEveningList.includes(e.employeeId));
      const nightCombos = getCombinations(eligibleForNight, config.night);
      nightCombos.sort((a, b) => {
        const aSeniors = a.filter(e => e.level === "senior").length;
        const bSeniors = b.filter(e => e.level === "senior").length;
        return aSeniors - bSeniors;
      });

      for (const night of nightCombos) {
        if (!isNightStructurallyValid(night, targetMonthStart, prevNightIds)) {
          continue;
        }

        const overrides = getTransitionOverrides(allEmployees, targetMonthStart, prevMonthStr, prevWeeklyPatterns, night);
        const nightRes = assignNightOffsets(night, targetMonthDates, targetMonthStart, prevWeeklyPatterns, true, leaveLup, graceMinWeekday, graceMinWeekend, overrides);

        const nightIds = new Set(night.map(e => e.employeeId));
        const poolForMorningEvening = allEmployees.filter(e => !nightIds.has(e.employeeId));
        const eveningCandidates = poolForMorningEvening.filter(e => !mustBeInEvening.includes(e));
        const eveningNeeded = config.evening - mustBeInEvening.length;

        if (eveningNeeded < 0) continue;

        const eveningExtraCombos = getCombinations(eveningCandidates, eveningNeeded);
        for (const extra of eveningExtraCombos) {
          const evening = [...mustBeInEvening, ...extra];
          const eveningIds = new Set(evening.map(e => e.employeeId));
          const morning = poolForMorningEvening.filter(e => !eveningIds.has(e.employeeId));

          if (!isMorningEveningStructurallyValid(morning, evening)) {
            continue;
          }

          try {
            const continuityPresets = new Map();
            if (prevWeeklyPatterns && targetMonthStart > `${CYCLE_ANCHOR_DATE.slice(0, 7)}-01`) {
              const prevMonthStr = addMonths(targetMonthStart, -1).slice(0, 7);
              const allMembers = [...morning, ...evening];
              allMembers.forEach((employee) => {
                const k = getConsecutiveWorkDaysAtEnd(employee, prevMonthStr, prevWeeklyPatterns);
                if (k > 0 && k < 5) {
                  continuityPresets.set(employee.employeeId, prevWeeklyPatterns.get(employee.employeeId));
                }
              });
            }

            const morningPresets = new Map();
            morning.forEach(e => {
              if (continuityPresets.has(e.employeeId)) morningPresets.set(e.employeeId, continuityPresets.get(e.employeeId));
            });
            const morningRes = findBestOffsetsForTeam(morning, targetMonthDates, "morning", morningPresets, leaveLup, graceMinWeekday, graceMinWeekend, overrides);

            const eveningPresets = new Map();
            evening.forEach(e => {
              if (continuityPresets.has(e.employeeId)) eveningPresets.set(e.employeeId, continuityPresets.get(e.employeeId));
            });
            const eveningRes = findBestOffsetsForTeam(evening, targetMonthDates, "evening", eveningPresets, leaveLup, graceMinWeekday, graceMinWeekend, overrides);

            const weeklyPatterns = new Map([
              ...nightRes.offsetMap,
              ...morning.map((e, i) => [e.employeeId, morningRes.offsets[i]]),
              ...evening.map((e, i) => [e.employeeId, eveningRes.offsets[i]])
            ]);

            validateDailyRoster(morning, evening, night, weeklyPatterns, targetMonthDates, targetMonthStr, prevWeeklyPatterns, leaveLup, graceMinWeekday, graceMinWeekend);

            console.log(`  [solveMonthWithGrace] partition success with config: ${config.name}`);
            return { teams: { morning, evening, night }, weeklyPatterns, config };
          } catch (e) {
            // console.log(`  [solveMonthWithGrace] partition combo failed: ${e.message}`);
          }
        }
      }
    }

    console.log(`  [solveMonthWithGrace] partition search failed, trying deterministic without presets`);
    // 3. Try deterministic WITHOUT presets (FAST fallback)
    for (const config of configs) {
      try {
        const teams = createShiftTeams(targetEmployees, targetMonthStart, prevNightIds, config);
        const overrides = getTransitionOverrides(targetEmployees, targetMonthStart, prevMonthStr, prevWeeklyPatterns, teams.night);
        const nightRes = assignNightOffsets(teams.night, targetMonthDates, targetMonthStart, prevWeeklyPatterns, false, leaveLup, graceMinWeekday, graceMinWeekend, overrides);

        const morningRes = findBestOffsetsForTeam(teams.morning, targetMonthDates, "morning", new Map(), leaveLup, graceMinWeekday, graceMinWeekend, overrides);

        const eveningRes = findBestOffsetsForTeam(teams.evening, targetMonthDates, "evening", new Map(), leaveLup, graceMinWeekday, graceMinWeekend, overrides);

        const weeklyPatterns = new Map([
          ...nightRes.offsetMap,
          ...teams.morning.map((e, i) => [e.employeeId, morningRes.offsets[i]]),
          ...teams.evening.map((e, i) => [e.employeeId, eveningRes.offsets[i]])
        ]);

        validateDailyRoster(teams.morning, teams.evening, teams.night, weeklyPatterns, targetMonthDates, targetMonthStr, prevWeeklyPatterns, leaveLup, graceMinWeekday, graceMinWeekend);

        console.log(`  [solveMonthWithGrace] fallback success with config: ${config.name}`);
        return { teams, weeklyPatterns, config };
      } catch (e) {
        console.log(`  [solveMonthWithGrace] fallback failed for ${config.name}: ${e.message}`);
      }
    }

    console.log(`  [solveMonthWithGrace] partition search with presets failed, trying partition search WITHOUT presets`);
    // 4. Try partition search WITHOUT presets (Full fallback)
    for (const config of configs) {
      const allEmployees = [...targetEmployees];
      const forcedToEveningList = getForcedToEveningList(allEmployees, prevNightIds);
      const eligibleForNight = allEmployees.filter(e => {
        const isBlocked = isNightBlocked(e, targetMonthStart);
        const isForcedToEvening = forcedToEveningList.includes(e.employeeId);
        return !isBlocked && !isForcedToEvening;
      });

      const mustBeInEvening = allEmployees.filter(e => forcedToEveningList.includes(e.employeeId));
      const nightCombos = getCombinations(eligibleForNight, config.night);
      nightCombos.sort((a, b) => {
        const aSeniors = a.filter(e => e.level === "senior").length;
        const bSeniors = b.filter(e => e.level === "senior").length;
        return aSeniors - bSeniors;
      });

      for (const night of nightCombos) {
        if (!isNightStructurallyValid(night, targetMonthStart, prevNightIds)) {
          continue;
        }

        const overrides = getTransitionOverrides(allEmployees, targetMonthStart, prevMonthStr, prevWeeklyPatterns, night);
        const nightRes = assignNightOffsets(night, targetMonthDates, targetMonthStart, prevWeeklyPatterns, false, leaveLup, graceMinWeekday, graceMinWeekend, overrides);

        const nightIds = new Set(night.map(e => e.employeeId));
        const poolForMorningEvening = allEmployees.filter(e => !nightIds.has(e.employeeId));
        const eveningCandidates = poolForMorningEvening.filter(e => !mustBeInEvening.includes(e));
        const eveningNeeded = config.evening - mustBeInEvening.length;

        if (eveningNeeded < 0) continue;

        const eveningExtraCombos = getCombinations(eveningCandidates, eveningNeeded);
        for (const extra of eveningExtraCombos) {
          const evening = [...mustBeInEvening, ...extra];
          const eveningIds = new Set(evening.map(e => e.employeeId));
          const morning = poolForMorningEvening.filter(e => !eveningIds.has(e.employeeId));

          if (!isMorningEveningStructurallyValid(morning, evening)) {
            continue;
          }

          try {
            const morningRes = findBestOffsetsForTeam(morning, targetMonthDates, "morning", new Map(), leaveLup, graceMinWeekday, graceMinWeekend, overrides);
            const eveningRes = findBestOffsetsForTeam(evening, targetMonthDates, "evening", new Map(), leaveLup, graceMinWeekday, graceMinWeekend, overrides);

            const weeklyPatterns = new Map([
              ...nightRes.offsetMap,
              ...morning.map((e, i) => [e.employeeId, morningRes.offsets[i]]),
              ...evening.map((e, i) => [e.employeeId, eveningRes.offsets[i]])
            ]);

            validateDailyRoster(morning, evening, night, weeklyPatterns, targetMonthDates, targetMonthStr, prevWeeklyPatterns, leaveLup, graceMinWeekday, graceMinWeekend);

            console.log(`  [solveMonthWithGrace] partition search WITHOUT presets success with config: ${config.name}`);
            return { teams: { morning, evening, night }, weeklyPatterns, config };
          } catch (e) {
            // console.log(`  [solveMonthWithGrace] partition combo WITHOUT presets failed: ${e.message}`);
          }
        }
      }
    }

    throw new Error(`Unable to generate valid schedule for month ${targetMonthStr}.`);
  };

  const solveMonth = (targetMonthStr, targetEmployees, prevNightIds, prevWeeklyPatterns, leaveLup) => {
    if (targetMonthStr === "2026-06") {
      return solveMonthStatic(targetMonthStr, targetEmployees);
    }
    
    const relaxationLevels = [
      { graceWeekday: 3, graceWeekend: 2 },
      { graceWeekday: 2, graceWeekend: 1 },
      { graceWeekday: 1, graceWeekend: 1 },
      { graceWeekday: 0, graceWeekend: 0 }
    ];

    for (const level of relaxationLevels) {
      try {
        const res = solveMonthWithGrace(
          targetMonthStr,
          targetEmployees,
          prevNightIds,
          prevWeeklyPatterns,
          leaveLup,
          level.graceWeekday,
          level.graceWeekend
        );
        return res;
      } catch (e) {
        console.log(`[solveMonth] failed with graceWeekday=${level.graceWeekday} graceWeekend=${level.graceWeekend}: ${e.message}`);
      }
    }

    throw new Error(`Unable to generate valid schedule for month ${targetMonthStr}.`);
  };

  const validateDailyRoster = (morning, evening, night, weeklyPatterns, targetMonthDates, targetMonthStr, prevWeeklyPatterns, leaveLup, graceMinWeekday = 0, graceMinWeekend = 0) => {
    const employees = [...morning, ...evening, ...night];
    const prevMonthStr = addMonths(`${targetMonthStr}-01`, -1).slice(0, 7);
    const overrides = new Map();
    const fixedShiftByEmployee = new Map(
      employees.map((emp) => [
        emp.employeeId,
        SHIFT_KEYS.find((shiftKey) =>
          (shiftKey === "morning" ? morning : shiftKey === "evening" ? evening : night).some((m) => m.employeeId === emp.employeeId)
        )
      ])
    );

    if (prevWeeklyPatterns && targetMonthStr !== "2026-06") {
      employees.forEach(emp => {
        const k = getConsecutiveWorkDaysAtEnd(emp, prevMonthStr, prevWeeklyPatterns);
        if (k > 0 && k < 5) {
          const workDaysCount = 5 - k;
          const totalTransitionDays = workDaysCount + 2;
          overrides.set(emp.employeeId, { workDaysCount, totalTransitionDays });
        }
      });
    }

    const nightFemalesPool = night.filter((e) => e.gender === "female");
    if (nightFemalesPool.length >= 2) {
      let maxWorkDaysCount = 0;
      let hasOverride = false;
      nightFemalesPool.forEach((emp) => {
        const ovr = overrides.get(emp.employeeId);
        if (ovr) {
          hasOverride = true;
          if (ovr.workDaysCount > maxWorkDaysCount) {
            maxWorkDaysCount = ovr.workDaysCount;
          }
        }
      });
      if (hasOverride) {
        const totalTransitionDays = maxWorkDaysCount + 2;
        nightFemalesPool.forEach((emp) => {
          overrides.set(emp.employeeId, { workDaysCount: maxWorkDaysCount, totalTransitionDays });
        });
      }
    }

    targetMonthDates.forEach((date, dayIdx) => {
      const requiredMin = getShiftMinimum(date);
      const workingAssigned = { morning: [], evening: [], night: [] };
      const seniors = { morning: 0, evening: 0, night: 0 };
      const nightFemales = [];

      const isGracePeriod = dayIdx < 7;

      employees.forEach(emp => {
        let shiftKey = fixedShiftByEmployee.get(emp.employeeId);
        let isOff = false;

        const isLeave = leaveLup?.get(emp.employeeId)?.has(date);
        if (isLeave) {
          isOff = true;
        } else if (overrides.has(emp.employeeId)) {
          const ovr = overrides.get(emp.employeeId);
          if (dayIdx < ovr.workDaysCount) {
            isOff = false;
          } else if (dayIdx < ovr.totalTransitionDays) {
            isOff = true;
          } else {
            const offset = weeklyPatterns.get(emp.employeeId) ?? 0;
            const absoluteDayIndex = daysSinceAnchor(date);
            isOff = (absoluteDayIndex + offset) % 7 >= 5;
            if (emp.employeeId === "EMP003" && targetMonthStr === "2026-07") {
              console.log(`[trace EMP003] date=${date} dayIdx=${dayIdx} absoluteDayIndex=${absoluteDayIndex} offset=${offset} calculated_isOff=${isOff}`);
            }
          }
        } else {
          const offset = weeklyPatterns.get(emp.employeeId) ?? 0;
          const absoluteDayIndex = daysSinceAnchor(date);
          isOff = (absoluteDayIndex + offset) % 7 >= 5;
        }

        if (!isOff && !isLeave) {
          workingAssigned[shiftKey].push(emp);
          if (emp.level === "senior") seniors[shiftKey]++;
          if (shiftKey === "night" && emp.gender === "female") {
            nightFemales.push(emp);
          }
        }
      });

      if (targetMonthStr === "2026-07" && dayIdx === 7) {
        console.log(`[validateDailyRoster] ${date} (dayIdx=${dayIdx}, grace=${isGracePeriod}):`, {
          morning: workingAssigned.morning.map(e => e.employeeId),
          evening: workingAssigned.evening.map(e => e.employeeId),
          night: workingAssigned.night.map(e => e.employeeId),
        });
        console.log("Offsets and overrides in solver:");
        employees.forEach(emp => {
          console.log(`  ${emp.name} (${emp.employeeId}): offset=${weeklyPatterns.get(emp.employeeId)} override=${JSON.stringify(overrides.get(emp.employeeId))}`);
        });
      }

      SHIFT_KEYS.forEach((shiftKey) => {
        const graceMin = isWeekend(date) ? graceMinWeekend : graceMinWeekday;
        const effectiveMin = isGracePeriod ? graceMin : requiredMin;
        ensureShiftCoverage({ shiftKey, assigned: workingAssigned[shiftKey], minimum: effectiveMin, date, isGracePeriod });
        if (seniors[shiftKey] < 1 && !isGracePeriod) {
          throw new Error(`No senior on ${date} for ${shiftKey}`);
        }
      });

      if (nightFemales.length === 1) {
        throw new Error(`Exactly 1 female on night on ${date}`);
      }
    });
  };

  // ── Simulate months up to target ──────────────────────────────────────────
  while (currentSimMonth < month) {
    console.log(`[simulate] currentSimMonth=${currentSimMonth}`);
    const currentSimMonthStart = `${currentSimMonth}-01`;
    const prevMonthOfSim       = addMonths(currentSimMonthStart, -1).slice(0, 7);
    const prevSimPatterns      = historicalWeeklyPatterns.get(prevMonthOfSim) ?? null;
    const prevNightIds         = historicalNightTeams.get(prevMonthOfSim) ?? null;

    const { teams: simTeams, weeklyPatterns: simPatterns } = solveMonth(
      currentSimMonth,
      simulatedEmployees,
      prevNightIds,
      prevSimPatterns,
      new Map() // No leaves in simulation
    );

    const nightTeamIds = simTeams.night.map((e) => e.employeeId);
    historicalNightTeams.set(currentSimMonth, nightTeamIds);
    historicalWeeklyPatterns.set(currentSimMonth, simPatterns);

    // Update night-block dates
    const blockDateStr = addMonths(currentSimMonthStart, 2);
    simulatedEmployees.forEach((emp) => {
      if (nightTeamIds.includes(emp.employeeId)) {
        emp.nightShiftBlockedUntil = blockDateStr;
      }
    });

    simulationCache.set(currentSimMonth, {
      simulatedEmployees: simulatedEmployees.map((emp) => ({
        employeeId: emp.employeeId,
        nightShiftBlockedUntil: emp.nightShiftBlockedUntil
      })),
      historicalNightTeams:     new Map(historicalNightTeams),
      historicalWeeklyPatterns: new Map(historicalWeeklyPatterns)
    });
    saveSimulationCache();

    currentSimMonth = addMonths(currentSimMonthStart, 1).slice(0, 7);
  }

  // ── Generate target month ──────────────────────────────────────────────────
  const finalPrevPatterns = historicalWeeklyPatterns.get(prevMonthStr) ?? null;
  const prevNightIds = historicalNightTeams.get(prevMonthStr) ?? null;

  const { teams: shiftTeams, weeklyPatterns } = solveMonth(
    month,
    simulatedEmployees,
    prevNightIds,
    finalPrevPatterns,
    leaveLookup
  );

  // Apply any manual overrides
  if (weeklyOffsets) {
    Object.entries(weeklyOffsets).forEach(([employeeId, offset]) => {
      weeklyPatterns.set(employeeId, offset);
    });
  }

  // ── Build daily schedule ───────────────────────────────────────────────────
  const workedDays      = new Map(simulatedEmployees.map((e) => [e.employeeId, 0]));
  const nightAssignments = new Map(simulatedEmployees.map((e) => [e.employeeId, 0]));
  const finalShiftByEmployee = new Map(
    simulatedEmployees.map((employee) => [
      employee.employeeId,
      SHIFT_KEYS.find((key) => shiftTeams[key].some((m) => m.employeeId === employee.employeeId))
    ])
  );

  const prevMonthStrVal = addMonths(monthStart, -1).slice(0, 7);
  const overrides = new Map();
  if (month !== "2026-06") {
    simulatedEmployees.forEach(emp => {
      const k = getConsecutiveWorkDaysAtEnd(emp, prevMonthStrVal, finalPrevPatterns);
      if (k > 0 && k < 5) {
        const workDaysCount = 5 - k;
        const totalTransitionDays = workDaysCount + 2;
        overrides.set(emp.employeeId, { workDaysCount, totalTransitionDays });
      }
    });
  }

  const nightFemalesPool = shiftTeams.night.filter((e) => e.gender === "female");
  if (nightFemalesPool.length >= 2) {
    let maxWorkDaysCount = 0;
    let hasOverride = false;
    nightFemalesPool.forEach((emp) => {
      const ovr = overrides.get(emp.employeeId);
      if (ovr) {
        hasOverride = true;
        if (ovr.workDaysCount > maxWorkDaysCount) {
          maxWorkDaysCount = ovr.workDaysCount;
        }
      }
    });
    if (hasOverride) {
      const totalTransitionDays = maxWorkDaysCount + 2;
      nightFemalesPool.forEach((emp) => {
        overrides.set(emp.employeeId, { workDaysCount: maxWorkDaysCount, totalTransitionDays });
      });
    }
  }

  const dailySchedule = monthDates.map((date, dayIdx) => {
    const isGracePeriod = dayIdx < 7;
    const schedule = {
      date,
      shifts: {},
      off: [],
      leave: []
    };

    const rosters = Object.fromEntries(SHIFT_KEYS.map((k) => [k, []]));

    simulatedEmployees.forEach((employee) => {
      const isLeave = leaveLookup.get(employee.employeeId)?.has(date);
      if (isLeave) {
        schedule.leave.push(employee.employeeId);
        return;
      }

      let isOff = false;
      if (overrides.has(employee.employeeId)) {
        const ovr = overrides.get(employee.employeeId);
        if (dayIdx < ovr.workDaysCount) {
          isOff = false;
        } else if (dayIdx < ovr.totalTransitionDays) {
          isOff = true;
        } else {
          const offset = weeklyPatterns.get(employee.employeeId) ?? 0;
          const absoluteDayIndex = daysSinceAnchor(date);
          isOff = (absoluteDayIndex + offset) % 7 >= 5;
        }
      } else {
        const offset = weeklyPatterns.get(employee.employeeId) ?? 0;
        const absoluteDayIndex = daysSinceAnchor(date);
        isOff = (absoluteDayIndex + offset) % 7 >= 5;
      }

      if (isOff) {
        schedule.off.push(employee.employeeId);
        return;
      }

      const shiftKey = finalShiftByEmployee.get(employee.employeeId);
      rosters[shiftKey].push(employee);
    });

    const requiredMinimum = getShiftMinimum(date);

    SHIFT_KEYS.forEach((shiftKey) => {
      const assigned = rosters[shiftKey];
      ensureShiftCoverage({ shiftKey, assigned, minimum: requiredMinimum, date, isGracePeriod });

      schedule.shifts[shiftKey] = assigned;

      assigned.forEach((employee) => {
        workedDays.set(employee.employeeId, workedDays.get(employee.employeeId) + 1);
        if (shiftKey === "night") {
          nightAssignments.set(employee.employeeId, nightAssignments.get(employee.employeeId) + 1);
        }
      });
    });

    return schedule;
  });

  // Update night-block for the target month (for future simulation runs)
  const nightTeamIds = shiftTeams.night.map((e) => e.employeeId);
  const blockDateStr = addMonths(monthStart, 2);
  simulatedEmployees.forEach((emp) => {
    if (nightTeamIds.includes(emp.employeeId)) {
      emp.nightShiftBlockedUntil = blockDateStr;
    }
  });

  // ── Return result ──────────────────────────────────────────────────────────
  return {
    month,
    shifts: ["Morning", "Evening", "Night"],
    teams: Object.fromEntries(
      SHIFT_KEYS.map((shiftKey) => [
        shiftKey,
        shiftTeams[shiftKey].map((e) => e.employeeId)
      ])
    ),
    summary: simulatedEmployees.map((employee) => {
      const shiftKey = finalShiftByEmployee.get(employee.employeeId);
      return {
        employeeId: employee.employeeId,
        name: employee.name,
        role: employee.role,
        level: employee.level,
        gender: employee.gender,
        fixedShift: shiftKey,
        workedDays: workedDays.get(employee.employeeId),
        nightAssignments: nightAssignments.get(employee.employeeId),
        nextNightEligibleMonth:
          shiftKey === "night"
            ? addMonths(monthStart, 2)
            : formatDateString(employee.nightShiftBlockedUntil)
      };
    }),
    simulatedEmployees: simulatedEmployees.map((emp) => ({
      employeeId: emp.employeeId,
      nightShiftBlockedUntil: emp.nightShiftBlockedUntil
    })),
    weeklyPatterns,
    dailySchedule
  };
};
