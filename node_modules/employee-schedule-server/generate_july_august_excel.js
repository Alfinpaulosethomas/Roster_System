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
  console.log("Generating June, July, and August schedules...");
  
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

  // Helper to build sheet data matrix
  const buildGroupedSheetData = (monthRes, monthStr) => {
    const dates = getMonthDates(monthStr);
    const employeeSchedules = {};
    employeeSeed.forEach(emp => {
      employeeSchedules[emp.employeeId] = {};
    });

    monthRes.dailySchedule.forEach(day => {
      const date = day.date;
      day.leave.forEach(empId => {
        employeeSchedules[empId][date] = "Leave";
      });
      day.off.forEach(empId => {
        employeeSchedules[empId][date] = "Off";
      });
      Object.keys(day.shifts).forEach(shiftKey => {
        const displayName = shiftKey.charAt(0).toUpperCase() + shiftKey.slice(1);
        day.shifts[shiftKey].forEach(emp => {
          employeeSchedules[emp.employeeId][date] = displayName;
        });
      });
    });

    const dateHeaders = dates.map(d => d.slice(5));
    const sheetData = [
      ["Employee ID", "Employee Name", "Role", "Level", "Shift Group", ...dateHeaders]
    ];

    ["morning", "evening", "night"].forEach(shiftKey => {
      const displayShift = shiftKey.charAt(0).toUpperCase() + shiftKey.slice(1);
      const empIds = monthRes.teams[shiftKey];
      const emps = empIds.map(id => employeeSeed.find(e => e.employeeId === id));
      
      emps.forEach(emp => {
        if (!emp) return;
        const combinedName = `${emp.name} (${emp.employeeId})`; // Keep employee ID with their names
        const row = [
          emp.employeeId,
          combinedName,
          emp.role,
          emp.level.charAt(0).toUpperCase() + emp.level.slice(1),
          displayShift,
        ];
        dates.forEach(date => {
          const shift = employeeSchedules[emp.employeeId][date] || "Off";
          row.push(shift);
        });
        sheetData.push(row);
      });
    });

    return sheetData;
  };

  // Build the data
  const julyData = buildGroupedSheetData(julyRes, "2026-07");
  const augustData = buildGroupedSheetData(augustRes, "2026-08");

  // Save utility
  const saveWorkbook = (wb, fileName) => {
    // 1. Write to Artifacts
    const artifactPath = path.join(ARTIFACT_DIR, fileName);
    try {
      XLSX.writeFile(wb, artifactPath);
      console.log(`Wrote to Artifact: ${artifactPath}`);
    } catch (e) {
      console.error(`Failed to write to Artifact ${artifactPath}:`, e.message);
    }

    // 2. Write to Client Public (for localhost download)
    const clientPath = path.join(CLIENT_PUBLIC_DIR, fileName);
    try {
      XLSX.writeFile(wb, clientPath);
      console.log(`Wrote to Client Public: ${clientPath}`);
    } catch (e) {
      console.error(`Failed to write to Client Public ${clientPath}:`, e.message);
    }

    // 3. Write to Workspace
    const workspacePath = path.join(WORKSPACE_DIR, fileName);
    try {
      XLSX.writeFile(wb, workspacePath);
      console.log(`Wrote to Workspace: ${workspacePath}`);
    } catch (e) {
      console.warn(`WARNING: Could not write to Workspace path ${workspacePath} (likely open/locked):`, e.message);
    }
  };

  // Generate July Grouped Workbook
  const wbJuly = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wbJuly, XLSX.utils.aoa_to_sheet(julyData), "July 2026 Grouped");
  saveWorkbook(wbJuly, "july_2026_schedule_grouped.xlsx");

  // Generate August Grouped Workbook
  const wbAugust = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wbAugust, XLSX.utils.aoa_to_sheet(augustData), "August 2026 Grouped");
  saveWorkbook(wbAugust, "august_2026_schedule_grouped.xlsx");

  // Generate Combined July & August Workbook
  const wbCombined = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wbCombined, XLSX.utils.aoa_to_sheet(julyData), "July 2026 Grouped");
  XLSX.utils.book_append_sheet(wbCombined, XLSX.utils.aoa_to_sheet(augustData), "August 2026 Grouped");
  saveWorkbook(wbCombined, "july_august_2026_schedule_grouped.xlsx");

  console.log("Excel files generation completed successfully.");

} catch (e) {
  console.error("Error generating Excel:", e);
}
