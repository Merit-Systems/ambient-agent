import type { AgentPersonality } from "./personalities";

export interface Agent {
  id: string;
  name: string;
  personality: AgentPersonality;
}
