import { mrWhiskersPersonality } from "./personalities";
import type { Agent } from "./types";

export const mrWhiskersAgent: Agent = {
  id: mrWhiskersPersonality.id,
  name: mrWhiskersPersonality.name,
  personality: mrWhiskersPersonality,
};
