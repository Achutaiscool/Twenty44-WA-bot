// utils/dateHelpers.js
import { format, addDays, startOfWeek, parseISO } from "date-fns";

/**
 * formatUserDate(isoDate)
 * isoDate: "YYYY-MM-DD"
 * returns: formatted string like "Wed Oct 29 2025"
 */
export const formatUserDate = (isoDate) => {
  if (!isoDate) return "";
  const d = parseISO(isoDate);
  return format(d, "EEE MMM dd yyyy");
};

export const getDaysForWeekStartingAt = (startDateIso) => {
  const dd = parseISO(startDateIso);
  const arr = [];
  for (let i = 0; i < 7; i++) {
    const d = addDays(dd, i);
    arr.push(format(d, "yyyy-MM-dd"));
  }
  return arr;
};

export const getNextNDates = (count = 7, fromDate = new Date()) => {
  const arr = [];
  for (let i = 0; i < count; i++) {
    arr.push(format(addDays(fromDate, i), "yyyy-MM-dd"));
  }
  return arr;
};

export const startOfCurrentWeek = (from = new Date()) => {
  return format(startOfWeek(from, { weekStartsOn: 1 }), "yyyy-MM-dd"); // week starts Monday
};
