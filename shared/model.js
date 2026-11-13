// Weekly data model — pure functions, no Firebase, no DOM (tested with `node --test`).
//
// Firestore shape (all under users/{uid}/):
//   weekly_activities/{activityId}  { name, archived, createdAt }
//   weekly_template/main            { days: { mon: [Slot], ..., sun: [Slot] }, updatedAt }
//   weekly_days/{YYYY-MM-DD}        { slots: [Slot], ticks: {slotId: true}, skipped: {slotId: true},
//                                     rest: bool, extras: [Slot], moved: {slotId: 'HH:MM'}, updatedAt }
//   Slot = { slotId, activityId, time: 'HH:MM' }
//
// A day doc's `slots` is a snapshot of the template for that weekday. Today and future days
// follow the template; once a day is over its snapshot is frozen, so editing the template
// never rewrites history.

export const ROLLOVER_HOUR = 4;  // a tick at 1 AM still belongs to the day you're finishing
export const WEEKDAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];

const pad = n => String(n).padStart(2, '0');

/** Local midnight of the day that "today" means right now, given the rollover hour. */
export function activeDate(now = new Date(), rollover = ROLLOVER_HOUR) {
  const d = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  if (now.getHours() < rollover) d.setDate(d.getDate() - 1);
  return d;
}

export function dateKey(d) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function parseKey(key) {
  const [y, m, d] = key.split('-').map(Number);
  return new Date(y, m - 1, d);
}

export function weekdayOf(key) {
  return WEEKDAYS[(parseKey(key).getDay() + 6) % 7];  // JS: 0 = Sunday
}

export function todayKey(now = new Date(), rollover = ROLLOVER_HOUR) {
  return dateKey(activeDate(now, rollover));
}

/** Milliseconds until the next rollover moment (when "today" changes). */
export function msUntilRollover(now = new Date(), rollover = ROLLOVER_HOUR) {
  const next = activeDate(now, rollover);
  next.setDate(next.getDate() + 1);
  next.setHours(rollover, 0, 0, 0);
  return Math.max(1000, next - now);
}

export function templateSlots(template, key) {
  const list = (template && template.days && template.days[weekdayOf(key)]) || [];
  return list.map(s => ({ slotId: s.slotId, activityId: s.activityId, time: s.time }));
}

/**
 * The slot list a day doc should hold. Past days keep their snapshot; today/future follow the
 * template (so editing Monday's plan on a Monday updates today's widget).
 */
export function snapshotFor(dayDoc, template, key, todayK) {
  if (key < todayK && dayDoc && Array.isArray(dayDoc.slots)) return dayDoc.slots;
  return templateSlots(template, key);
}

function sameSlots(a, b) {
  if (!Array.isArray(a) || a.length !== b.length) return false;
  return a.every((s, i) => s.slotId === b[i].slotId && s.activityId === b[i].activityId && s.time === b[i].time);
}

/** True if the stored day doc's snapshot needs (re)writing. */
export function needsSnapshot(dayDoc, template, key, todayK) {
  if (key < todayK) return !(dayDoc && Array.isArray(dayDoc.slots));
  return !dayDoc || !sameSlots(dayDoc.slots, templateSlots(template, key));
}

/**
 * Everything the widget shows for one date, sorted by time.
 * Item = { slotId, activityId, time, name, done, skipped, extra }
 */
export function dayItems(dayDoc, template, activities, key, todayK) {
  const doc = dayDoc || {};
  const ticks = doc.ticks || {};
  const skipped = doc.skipped || {};
  const moved = doc.moved || {};
  const base = snapshotFor(dayDoc, template, key, todayK).map(s => ({ ...s, extra: false }));
  const extras = (doc.extras || []).map(s => ({ ...s, extra: true }));
  return base.concat(extras)
    .map(s => ({
      slotId: s.slotId,
      activityId: s.activityId,
      time: moved[s.slotId] || s.time,
      name: (activities[s.activityId] && activities[s.activityId].name) || 'Removed activity',
      done: ticks[s.slotId] === true,
      skipped: skipped[s.slotId] === true,
      extra: s.extra,
    }))
    .sort((a, b) => byTime(a, b) || a.slotId.localeCompare(b.slotId));
}

/**
 * Streak = how many scheduled days in a row this activity was done, counting back from today.
 * Days it isn't scheduled are skipped (Mon/Wed/Fri workout: Tue/Thu don't break it).
 * Today counts once ticked; an unticked today doesn't break the streak until the day is over.
 * A day counts as done when every slot of that activity on that day is ticked.
 */
export function streakFor(activityId, data, todayK, maxDays = 400) {
  let count = 0;
  const d = parseKey(todayK);
  for (let i = 0; i < maxDays; i++, d.setDate(d.getDate() - 1)) {
    const key = dateKey(d);
    const day = data.days[key];
    const slots = snapshotFor(day, data.template, key, todayK).filter(s => s.activityId === activityId);
    if (slots.length === 0) continue;                       // not scheduled that day
    const ticks = (day && day.ticks) || {};
    const done = slots.every(s => ticks[s.slotId] === true);
    if (done) count++;
    else if (key !== todayK) break;                         // a missed past day ends the streak
  }
  return count;
}

const norm = name => name.trim().replace(/\s+/g, ' ').toLowerCase();

function usesOf(template, activityId) {
  return WEEKDAYS.reduce((n, wd) => n + ((template.days[wd] || []).filter(s => s.activityId === activityId).length), 0);
}

/**
 * The editor typed `name` into slot `slotId`. Decide which activity the slot points at, so that
 * the same name on different days is the same activity (one shared streak).
 *  - name matches an existing activity  -> reuse it
 *  - slot's activity is used only here  -> rename it in place (keeps its streak)
 *  - otherwise                          -> a new activity
 * Returns { activities, activityId } — a new activities object, never mutates the input.
 */
export function resolveActivity(activities, template, slotId, name, newId) {
  const clean = name.trim().replace(/\s+/g, ' ');
  const match = Object.keys(activities).find(id => norm(activities[id].name) === norm(clean));
  if (match) return { activities, activityId: match };
  const slot = WEEKDAYS.flatMap(wd => template.days[wd] || []).find(s => s.slotId === slotId);
  if (slot && activities[slot.activityId] && usesOf(template, slot.activityId) === 1) {
    return { activities: { ...activities, [slot.activityId]: { name: clean } }, activityId: slot.activityId };
  }
  return { activities: { ...activities, [newId]: { name: clean } }, activityId: newId };
}

/**
 * Quick-pick list for the editor: every activity ever named (the activities list is
 * the local "database" — names stay in it after their last slot is deleted).
 * Typed text filters it: names starting with it first, then names containing it;
 * within each, the most-scheduled first, then A-Z. Empty text lists everything.
 * Returns [{ id, name, uses }], at most `limit`.
 */
export function suggestActivities(activities, template, typed, limit = 8) {
  const q = norm(typed || '');
  const seen = new Set();
  const out = [];
  for (const id of Object.keys(activities)) {
    const name = (activities[id] && activities[id].name) || '';
    const key = norm(name);
    if (!key || seen.has(key)) continue;
    const at = key.indexOf(q);
    if (q && at < 0) continue;
    seen.add(key);
    out.push({ id, name, uses: usesOf(template, id), rank: q && at === 0 ? 0 : 1 });
  }
  out.sort((a, b) => a.rank - b.rank || b.uses - a.uses || a.name.localeCompare(b.name));
  return out.slice(0, limit).map(({ id, name, uses }) => ({ id, name, uses }));
}

/** Timed ones first, in time order; ones with no set time ('') after them. */
export function byTime(a, b) {
  return (!a.time) - (!b.time) || a.time.localeCompare(b.time);
}

export function sortSlots(slots) {
  return slots.slice().sort(byTime);
}

/** '' = no set time ("do it today"): shown without a time, listed after the timed ones. */
export function formatTime(hhmm) {
  if (!hhmm) return { hm: '', ap: '' };
  const [h, m] = hhmm.split(':').map(Number);
  return { hm: `${((h + 11) % 12) + 1}:${pad(m)}`, ap: h < 12 ? 'AM' : 'PM' };
}
