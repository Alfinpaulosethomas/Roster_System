import fs from 'fs';
import path from 'path';
import XLSX from 'xlsx';
import { employeeSeed } from "./src/data/employees.js";
import { generateSchedule, clearSimulationCache } from "./src/utils/scheduler.js";
import { getMonthDates } from "./src/utils/date.js";

const ARTIFACT_DIR = "C:/Users/alfin/.gemini/antigravity/brain/51d56c9d-0532-4db0-9441-cb36988a0fc6";
const WORKSPACE_DIR = "c:/Users/alfin/OneDrive/Desktop/Employee_System";
const CLIENT_PUBLIC_DIR = "c:/Users/alfin/OneDrive/Desktop/Employee_System/client/public";

// Ensure client public directory exists
if (!fs.existsSync(CLIENT_PUBLIC_DIR)) {
  fs.mkdirSync(CLIENT_PUBLIC_DIR, { recursive: true });
}

try {
  console.log("Generating continuous July and August schedule...");
  
  // Clear cache to build fresh schedule
  clearSimulationCache();

  // 1. Simulate up to May 2026
  const simulatedEmployees = employeeSeed.map(emp => ({ ...emp, nightShiftBlockedUntil: null }));
  for (const m of ["2026-01", "2026-02", "2026-03", "2026-04", "2026-05"]) {
    const res = generateSchedule({ employees: simulatedEmployees, month: m, leaves: [] });
    simulatedEmployees.forEach(emp => {
      const se = res.simulatedEmployees?.find(x => x.employeeId === emp.employeeId);
      if (se) emp.nightShiftBlockedUntil = se.nightShiftBlockedUntil;
    });
  }

  // 2. Generate June schedule
  const juneRes = generateSchedule({ employees: simulatedEmployees, month: "2026-06", leaves: [] });
  
  // Carry over block state to July
  simulatedEmployees.forEach(emp => {
    const se = juneRes.simulatedEmployees?.find(x => x.employeeId === emp.employeeId);
    if (se) emp.nightShiftBlockedUntil = se.nightShiftBlockedUntil;
  });

  // 3. Generate July schedule
  const julyRes = generateSchedule({ employees: simulatedEmployees, month: "2026-07", leaves: [] });

  // Carry over block state to August
  simulatedEmployees.forEach(emp => {
    const se = julyRes.simulatedEmployees?.find(x => x.employeeId === emp.employeeId);
    if (se) emp.nightShiftBlockedUntil = se.nightShiftBlockedUntil;
  });

  // 4. Generate August schedule
  const augustRes = generateSchedule({ employees: simulatedEmployees, month: "2026-08", leaves: [] });

  // Get date arrays
  const julyDates = getMonthDates("2026-07");
  const augustDates = getMonthDates("2026-08");
  const allDates = [...julyDates, ...augustDates];

  // Helper to map daily schedule
  const buildDailyMap = (monthRes) => {
    const dailyMap = {};
    employeeSeed.forEach(emp => {
      dailyMap[emp.employeeId] = {};
    });

    monthRes.dailySchedule.forEach(day => {
      const date = day.date;
      day.leave.forEach(empId => {
        dailyMap[empId][date] = "Leave";
      });
      day.off.forEach(empId => {
        dailyMap[empId][date] = "Off";
      });
      Object.keys(day.shifts).forEach(shiftKey => {
        const displayName = shiftKey.charAt(0).toUpperCase() + shiftKey.slice(1);
        day.shifts[shiftKey].forEach(emp => {
          dailyMap[emp.employeeId][date] = displayName;
        });
      });
    });
    return dailyMap;
  };

  const julyDailyMap = buildDailyMap(julyRes);
  const augustDailyMap = buildDailyMap(augustRes);

  // Combine daily maps
  const combinedDailyMap = {};
  employeeSeed.forEach(emp => {
    combinedDailyMap[emp.employeeId] = {
      ...julyDailyMap[emp.employeeId],
      ...augustDailyMap[emp.employeeId]
    };
  });

  // Helper to save workbook in all locations
  const saveWorkbook = (wb, fileName) => {
    const artifactPath = path.join(ARTIFACT_DIR, fileName);
    try {
      XLSX.writeFile(wb, artifactPath);
      console.log(`Wrote to Artifact: ${artifactPath}`);
    } catch (e) {
      console.error(`Failed to write to Artifact ${artifactPath}:`, e.message);
    }

    const clientPath = path.join(CLIENT_PUBLIC_DIR, fileName);
    try {
      XLSX.writeFile(wb, clientPath);
      console.log(`Wrote to Client Public: ${clientPath}`);
    } catch (e) {
      console.error(`Failed to write to Client Public ${clientPath}:`, e.message);
    }

    const workspacePath = path.join(WORKSPACE_DIR, fileName);
    try {
      XLSX.writeFile(wb, workspacePath);
      console.log(`Wrote to Workspace: ${workspacePath}`);
    } catch (e) {
      console.warn(`WARNING: Could not write to Workspace path ${workspacePath}:`, e.message);
    }
  };

  // ─── LAYOUT 1: Continuous sheet grouped by July Shift Group ───
  const headers1 = ["Employee ID", "Employee Name", "Role", "Level", "July Shift Group", "August Shift Group", ...allDates.map(d => d.slice(5))];
  const sheetData1 = [headers1];

  ["morning", "evening", "night"].forEach(shiftKey => {
    const displayShift = shiftKey.charAt(0).toUpperCase() + shiftKey.slice(1);
    const empIds = julyRes.teams[shiftKey];
    const emps = empIds.map(id => employeeSeed.find(e => e.employeeId === id));

    emps.forEach(emp => {
      if (!emp) return;
      
      // Find August shift group for this employee
      let augShift = "Off";
      Object.keys(augustRes.teams).forEach(sk => {
        if (augustRes.teams[sk].includes(emp.employeeId)) {
          augShift = sk.charAt(0).toUpperCase() + sk.slice(1);
        }
      });

      const row = [
        emp.employeeId,
        `${emp.name} (${emp.employeeId})`,
        emp.role,
        emp.level.charAt(0).toUpperCase() + emp.level.slice(1),
        displayShift,
        augShift
      ];

      allDates.forEach(date => {
        const val = combinedDailyMap[emp.employeeId][date] || "Off";
        row.push(val);
      });

      sheetData1.push(row);
    });
  });

  const wbContinuous = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wbContinuous, XLSX.utils.aoa_to_sheet(sheetData1), "July-Aug Continuous");
  saveWorkbook(wbContinuous, "july_august_2026_continuous_schedule.xlsx");


  // ─── LAYOUT 2: Single sheet with two distinct sections (July top, August bottom) ───
  const headers2 = ["Employee ID", "Employee Name", "Role", "Level", "Shift Group", ...julyDates.map(d => d.slice(5))];
  const sheetData2 = [["JULY 2026 ROSTER GROUPED BY SHIFT"], headers2];

  // Add July rows
  ["morning", "evening", "night"].forEach(shiftKey => {
    const displayShift = shiftKey.charAt(0).toUpperCase() + shiftKey.slice(1);
    const empIds = julyRes.teams[shiftKey];
    const emps = empIds.map(id => employeeSeed.find(e => e.employeeId === id));

    emps.forEach(emp => {
      if (!emp) return;
      const row = [
        emp.employeeId,
        `${emp.name} (${emp.employeeId})`,
        emp.role,
        emp.level.charAt(0).toUpperCase() + emp.level.slice(1),
        displayShift
      ];
      julyDates.forEach(date => {
        const val = julyDailyMap[emp.employeeId][date] || "Off";
        row.push(val);
      });
      sheetData2.push(row);
    });
  });

  // Empty spacer rows
  sheetData2.push([]);
  sheetData2.push([]);

  // Add August header and rows
  sheetData2.push(["AUGUST 2026 ROSTER GROUPED BY SHIFT"]);
  sheetData2.push(["Employee ID", "Employee Name", "Role", "Level", "Shift Group", ...augustDates.map(d => d.slice(5))]);

  ["morning", "evening", "night"].forEach(shiftKey => {
    const displayShift = shiftKey.charAt(0).toUpperCase() + shiftKey.slice(1);
    const empIds = augustRes.teams[shiftKey];
    const emps = empIds.map(id => employeeSeed.find(e => e.employeeId === id));

    emps.forEach(emp => {
      if (!emp) return;
      const row = [
        emp.employeeId,
        `${emp.name} (${emp.employeeId})`,
        emp.role,
        emp.level.charAt(0).toUpperCase() + emp.level.slice(1),
        displayShift
      ];
      augustDates.forEach(date => {
        const val = augustDailyMap[emp.employeeId][date] || "Off";
        row.push(val);
      });
      sheetData2.push(row);
    });
  });

  const wbSections = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wbSections, XLSX.utils.aoa_to_sheet(sheetData2), "July & Aug Sections");
  saveWorkbook(wbSections, "july_august_2026_sections_schedule.xlsx");

  console.log("Continuous Excel files generated successfully.");

} catch (e) {
  console.error("Error generating continuous Excel:", e);
}
