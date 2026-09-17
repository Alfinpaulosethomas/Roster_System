import fs from 'fs';
import XLSX from 'xlsx';
import { employeeSeed } from "./src/data/employees.js";
import { generateSchedule, clearSimulationCache } from "./src/utils/scheduler.js";
import { getMonthDates } from "./src/utils/date.js";

const ARTIFACT_DIR = "C:/Users/alfin/.gemini/antigravity/brain/51d56c9d-0532-4db0-9441-cb36988a0fc6";

try {
  console.log("Generating June and July grouped schedules...");
  
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

  // Function to build and save a grouped schedule for a given month
  const saveGroupedExcel = (monthRes, monthStr, fileName) => {
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
        const row = [
          emp.employeeId,
          emp.name,
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

    const wb = XLSX.utils.book_new();
    const ws = XLSX.utils.aoa_to_sheet(sheetData);
    XLSX.utils.book_append_sheet(wb, ws, `${monthStr} Grouped`);

    const xlsxPath = `${ARTIFACT_DIR}/${fileName}`;
    XLSX.writeFile(wb, xlsxPath);
    console.log(`Successfully wrote grouped ${monthStr} schedule to Excel: ${xlsxPath}`);
  };

  // Generate June Grouped File
  saveGroupedExcel(juneRes, "2026-06", "june_2026_schedule_grouped.xlsx");

  // Generate July Grouped File
  saveGroupedExcel(julyRes, "2026-07", "july_2026_schedule_grouped.xlsx");

} catch (e) {
  console.error("Error generating Excel:", e);
}
