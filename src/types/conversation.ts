export interface UserResearchContext {
  summary?: string | null;
  interests?: string[];
  professional?: Record<string, unknown> | null;
  facts?: unknown[] | null;
  recentDocuments?: Array<{
    title: string;
    source: string;
    content?: string;
  }>;
}

export interface GroupParticipantInfo {
  phoneNumber: string;
  name?: string;
  brief?: string;
}

export interface SystemState {
  currentTime: {
    iso: string;
    formatted: string;
    timezone: string;
    dayOfWeek: string;
  };
  timezoneSource?: "known" | "default";
  connections: {
    gmail: boolean;
    github: boolean;
    calendar: boolean;
  };
  hasAnyConnection: boolean;
  connectionLink?: string;
  researchStatus?: "none" | "pending" | "completed";
  outboundOptIn?: boolean | null;
  isOnboarding?: boolean;
  hasExistingPayout?: boolean;
}
