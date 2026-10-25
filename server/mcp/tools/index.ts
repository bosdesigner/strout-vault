import type { ToolDef } from "./types.ts";
import { searchConversations } from "./search.ts";
import { getInteraction, listInteractions } from "./interactions.ts";
import { getParty } from "./parties.ts";
import { getProject } from "./projects.ts";
import { listOpenCommitments } from "./commitments.ts";
import { proposeUpdate } from "./propose.ts";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const TOOLS: ToolDef<any>[] = [searchConversations, getInteraction, listInteractions, getParty, getProject, listOpenCommitments, proposeUpdate];
