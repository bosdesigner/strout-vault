// Heuristics that guess which venture a recording belongs to. Edit freely: these are
// proposals for the review queue, never direct writes. Each workspace gets patterns that
// are tried against the title (strong signal) and counted across the transcript text
// (weaker, needs a clear majority). Keep the patterns to names that only one venture uses.
export interface WorkspaceRule {
  workspaceId: string;
  /** Matched against the recording title, case-insensitive. One hit is a strong signal. */
  title: RegExp[];
  /** Counted per transcript segment, case-insensitive. Needs a clear majority over the other workspaces. */
  transcript: RegExp[];
}

export const WORKSPACE_RULES: WorkspaceRule[] = [
  {
    workspaceId: "another_story",
    // Feasibility studies (discovery, onboarding, delivery) are AnotherStory's, not Strout Architecture's.
    title: [/another\s?story/i, /\bcontractor call\b/i, /\bfranchise/i, /feasibility/i],
    transcript: [/another\s?story/i, /anotherstorybldr/i, /\bfranchisee?s?\b/i, /\bterritor(y|ies)\b/i, /\bsecond[- ]story\b/i, /\bassessments?\b/i, /\bbuilder partners?\b/i, /feasibility stud(y|ies)/i],
  },
  {
    workspaceId: "phalanx",
    title: [/\bphalanx/i, /\bPN\b/, /\bshingle\s?x\b/i, /\bdermatryx\b/i, /\bdermal\s?x\b/i, /\bmill\s?pond\b/i],
    transcript: [/\bphalanx/i, /\bshingle\s?x\b/i, /\bnano\b/i, /\binvestor deck\b/i, /\bdermatryx\b/i, /\bdermal\s?x\b/i, /\bmill\s?pond\b/i, /\bwound care\b/i, /\bcap table\b/i],
  },
  {
    workspaceId: "credvault",
    title: [/cred\s?vault/i],
    transcript: [/cred\s?vault/i, /\bcredential vault\b/i],
  },
  {
    workspaceId: "sepp",
    title: [/\bSEPP\b/, /southeastern property/i, /owner'?s rep/i],
    transcript: [/\bSEPP\b/, /southeastern property/i, /owner'?s rep(resentative)?\b/i],
  },
  {
    workspaceId: "southern_shutter",
    title: [/southern shutter/i, /\bshutters?\b/i],
    transcript: [/southern shutter/i, /\bshutters?\b/i, /\bshutter renderer/i],
  },
  {
    // Transcript terms are the ones AnotherStory assessment calls do NOT also use: "floor plan" and
    // "architect" come up in both, so they count only in titles.
    workspaceId: "strout_arch",
    title: [/strout architecture/i, /\bdesign meeting\b/i, /\bfloor ?plans?\b/i, /\barchitect/i, /\bacres?\b/i],
    transcript: [/strout architecture/i, /\bsite plan\b/i, /\bpermit set\b/i, /\bschematic design\b/i, /\bconstruction documents?\b/i, /\bdesign (fee|contract|agreement)\b/i],
  },
];

/**
 * Titles Zoom fills in when nobody named the meeting. They say which Zoom account hosted the
 * call, not what it was about, so they carry no title signal on their own.
 */
export const ACCOUNT_DEFAULT_TITLES = [/^(ben strout'?s?|another story'?s?|zoom|my) (zoom |personal )?meeting( room)?$/i, /^zoom meeting$/i, /^[0-9a-f]{16,}$/i, /^IMG_\d+/i, /^\d{4}-\d{2}-\d{2}[ _T]/];
