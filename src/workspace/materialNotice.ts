/**
 * Which window shows the warning that material could not be used. Both
 * windows hear the event; the person looks at the meeting window while a
 * meeting runs and at the launcher otherwise, so exactly one of them speaks.
 */
export function shouldToastMaterial(windowLabel: string, meetingRunning: boolean, meetingId: string | null): boolean {
  const forAMeeting = meetingId !== null && meetingRunning;
  if (windowLabel === "overlay") return forAMeeting;
  if (windowLabel === "launcher") return !forAMeeting;
  return false;
}
