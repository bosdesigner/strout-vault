// Zod pieces shared by the tools' input schemas. Descriptions are written for the LLM that
// reads tools/list, so every parameter says what it filters and in which format.
import { z } from "zod";

export const workspaceArg = z.string().max(100).optional().describe("Workspace id (e.g. another_story, strout_arch). Must be within the token's scope; omit to search every workspace the token may read.");
export const partyIdArg = z.coerce.number().int().positive().optional().describe("Only interactions this party (person or org) took part in. Party ids come from get_party.");
export const projectIdArg = z.coerce.number().int().positive().optional().describe("Only interactions linked to this project. Project ids come from get_project.");
export const sinceArg = z.string().regex(/^\d{4}-\d{2}-\d{2}/, "YYYY-MM-DD or an ISO timestamp").optional().describe("Only interactions on or after this date (YYYY-MM-DD or ISO 8601).");
export const untilArg = z.string().regex(/^\d{4}-\d{2}-\d{2}/, "YYYY-MM-DD or an ISO timestamp").optional().describe("Only interactions before this date (YYYY-MM-DD or ISO 8601, exclusive).");
export const limitArg = z.coerce.number().int().min(1).optional().describe("Maximum results (default 20; anything above 50 is clamped to 50).");
