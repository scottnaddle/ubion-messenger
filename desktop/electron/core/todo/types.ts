/** On-device todo / meeting item (v1.1). Passcodes live in a separate safeStorage blob. */

export type TodoType = "todo" | "meeting" | "followup";
export type TodoStatus = "open" | "done" | "dismissed";
export type DatePrecision = "date" | "time" | "part-of-day" | "fuzzy";

export type TodoSource = {
  roomKey: string;
  messageId?: number;
  createdAt?: string;
  snippet?: string;
};

export type TodoItem = {
  id: string;
  title: string;
  type: TodoType;
  status: TodoStatus;
  due?: string; // ISO8601 local-ish (with offset preferred)
  start?: string;
  precision?: DatePrecision;
  requesterName?: string;
  requesterSeq?: number;
  assigneeName?: string;
  assigneeSeq?: number | null; // null = 미정
  roomKey?: string;
  source?: TodoSource;
  confidence: number;
  /** Zoom meeting id (digits only) when type=meeting */
  zoomMeetingId?: string;
  /** Join URL without pwd (pwd injected at join time from secrets) */
  zoomJoinUrl?: string;
  /** Has encrypted passcode in secrets store */
  hasZoomPasscode?: boolean;
  externalId?: string;
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
  /** Overdue reminder stage 0..3 */
  overdueStage?: number;
  lastOverdueAt?: string;
  /** Manual vs extracted */
  origin: "manual" | "auto" | "suggested";
};

export type TodoSuggestion = {
  id: string;
  kind: "add" | "complete" | "reschedule";
  draft: Omit<TodoItem, "id" | "createdAt" | "updatedAt" | "status" | "origin"> & {
    status?: TodoStatus;
    origin?: TodoItem["origin"];
  };
  evidenceText: string;
  roomKey: string;
  messageId?: number;
  createdAt: string;
};

export type NormalizedDate = {
  iso: string;
  precision: DatePrecision;
  role: "due" | "start" | "unknown";
  confidence: number;
  matched: string;
};

export type ZoomParse = {
  meetingId?: string;
  passcode?: string;
  joinUrl?: string;
  deepLink?: string;
  startIso?: string;
  title?: string;
  confidence: number;
};

export type ExtractResult = {
  title?: string;
  type: TodoType;
  score: number;
  due?: NormalizedDate;
  start?: NormalizedDate;
  isCompletion: boolean;
  isAcceptReply: boolean;
  isSelfPromise: boolean;
  isRequest: boolean;
  zoom?: ZoomParse;
  evidence: string;
};

export type TodoSettings = {
  /** Room keys where extraction is enabled (opt-in, default empty = all off) */
  enabledRooms: string[];
  /** Collect in every room (default off); per-room exclusions in disabledRooms */
  allRooms: boolean;
  disabledRooms: string[];
  /** First-run intro on 할일 tab dismissed */
  introSeen: boolean;
  remindersEnabled: boolean;
  /** Quiet outside [workStartHour, workEndHour) local */
  workStartHour: number;
  workEndHour: number;
  quietDuringMeetings: boolean;
  /** Minutes before Zoom start to notify */
  zoomNotifyMinutes: number[];
  /** LLM fallback hook — OFF by default, no server calls unless true */
  llmFallback: boolean;
  politeMode: boolean;
};
