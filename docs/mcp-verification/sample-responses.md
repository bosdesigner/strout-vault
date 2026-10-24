# Sample tool responses

The JSON each tool returned in the Inspector run of 2026-10-24 (`inspector-transcripts.md`), pretty-printed.
Deep links point at the local server; in production they carry PUBLIC_URL.

## search_conversations (hybrid)

```json
{
  "query": "copper gutters",
  "mode": "hybrid",
  "mode_used": "hybrid",
  "semantic_coverage": "full",
  "count": 3,
  "results": [
    {
      "interaction_id": 30,
      "title": "Ben Strout's Personal Meeting Room",
      "occurred_at": "2025-10-12T05:00:00.000Z",
      "source": "zoom",
      "kind": "meeting",
      "workspace_id": "another_story",
      "duration_sec": 1776,
      "score": 0.0315,
      "matched_by": [
        "keyword",
        "semantic"
      ],
      "keyword_hits": 3,
      "snippets": [
        {
          "start_sec": 585,
          "speaker": "Kevin McGuire",
          "text": "The copper gutters on the warehouse caught the light nicely in the drone footage.",
          "via": "keyword"
        },
        {
          "start_sec": 998,
          "speaker": "Ben Strout",
          "text": "The copper gutters on the warehouse caught the light nicely in the drone footage.",
          "via": "keyword"
        },
        {
          "start_sec": 1703,
          "speaker": "Kevin McGuire",
          "text": "The copper gutters on the warehouse caught the light nicely in the drone footage.",
          "via": "keyword"
        }
      ],
      "deep_link": "http://localhost:3000/r/30?t=585"
    },
    {
      "interaction_id": 26,
      "title": "Color pass sign-off",
      "occurred_at": "2025-06-03T03:30:00.000Z",
      "source": "zoom",
      "kind": "meeting",
      "workspace_id": "another_story",
      "duration_sec": 1681,
      "score": 0.03102,
      "matched_by": [
        "keyword",
        "semantic"
      ],
      "keyword_hits": 5,
      "snippets": [
        {
          "start_sec": 99,
          "speaker": "Kevin McGuire",
          "text": "The copper gutters on the warehouse caught the light nicely in the drone footage.",
          "via": "keyword"
        },
        {
          "start_sec": 512,
          "speaker": "Kevin McGuire",
          "text": "The copper gutters on the warehouse caught the light nicely in the drone footage.",
          "via": "keyword"
        },
        {
          "start_sec": 756,
          "speaker": "Kevin McGuire",
          "text": "The copper gutters on the warehouse caught the light nicely in the drone footage.",
          "via": "keyword"
        }
      ],
      "deep_link": "http://localhost:3000/r/26?t=99"
    },
    {
      "interaction_id": 22,
      "title": "Brand story outline",
      "occurred_at": "2025-01-14T20:00:00.000Z",
      "source": "zoom",
      "kind": "meeting",
      "workspace_id": "another_story",
      "duration_sec": 4356,
      "score": 0.03083,
      "matched_by": [
        "keyword",
        "semantic"
      ],
      "keyword_hits": 10,
      "snippets": [
        {
          "start_sec": 974,
          "speaker": "Kevin McGuire",
          "text": "The copper gutters on the warehouse caught the light nicely in the drone footage.",
          "via": "keyword"
        },
        {
          "start_sec": 1217,
          "speaker": "Sam Whitaker",
          "text": "The copper gutters on the warehouse caught the light nicely in the drone footage.",
          "via": "keyword"
        },
        {
          "start_sec": 1387,
          "speaker": "Kevin McGuire",
          "text": "The copper gutters on the warehouse caught the light nicely in the drone footage.",
          "via": "keyword"
        }
      ],
      "deep_link": "http://localhost:3000/r/22?t=974"
    }
  ]
}
```

## search_conversations (semantic, distinctive passage)

```json
{
  "query": "board observer seat",
  "mode": "semantic",
  "mode_used": "semantic",
  "semantic_coverage": "full",
  "count": 2,
  "results": [
    {
      "interaction_id": 12,
      "title": "Harbor Point seed terms",
      "occurred_at": "2024-02-12T10:30:00.000Z",
      "source": "zoom",
      "kind": "meeting",
      "workspace_id": "credvault",
      "duration_sec": 2713,
      "score": 0.01639,
      "matched_by": [
        "semantic"
      ],
      "keyword_hits": 0,
      "snippets": [
        {
          "start_sec": 242,
          "speaker": "Priya Natarajan",
          "text": "Priya Natarajan: Let's keep this meeting to thirty minutes if we can. The number I quoted earlier was an estimate; the firm price comes after the site visit. Ben Strout: The vault stores credentials encrypted at rest with per-tenant keys. Priya wants a board observer seat and her pro rata right, and she pushed the pre-…",
          "via": "semantic"
        }
      ],
      "deep_link": "http://localhost:3000/r/12?t=242"
    },
    {
      "interaction_id": 25,
      "title": "Dormer and attic bedroom options",
      "occurred_at": "2025-04-28T08:15:00.000Z",
      "source": "zoom",
      "kind": "meeting",
      "workspace_id": "strout_arch",
      "duration_sec": 4346,
      "score": 0.01613,
      "matched_by": [
        "semantic"
      ],
      "keyword_hits": 0,
      "snippets": [
        {
          "start_sec": 4248,
          "speaker": "Maria Delgado",
          "text": "Maria Delgado: Nora asked whether a screened porch could wrap the corner of the living room. Ben Strout: Carlos said the concrete pour is scheduled for Tuesday as long as the inspection passes Monday. Maria Delgado: Hardie board on the new walls and we match the lap exposure on the old siding. The structural engineer w…",
          "via": "semantic"
        },
        {
          "start_sec": 2622,
          "speaker": "Ben Strout",
          "text": "Ben Strout: The clients want a mudroom off the garage with a bench and cubbies for the kids. If that changes, flag it early and we will adjust the plan. Let's keep the roof pitch at six over twelve so it matches the original bungalow. Give me one second, I am pulling up the file. Maria Delgado: Nora asked whether a scr…",
          "via": "semantic"
        },
        {
          "start_sec": 1554,
          "speaker": "Maria Delgado",
          "text": "Maria Delgado: Carlos said the concrete pour is scheduled for Tuesday as long as the inspection passes Monday. The clients want a mudroom off the garage with a bench and cubbies for the kids. I think the realistic date is the end of next month, not this one. Ben Strout: Before we wrap, is there anything else on your li…",
          "via": "semantic"
        }
      ],
      "deep_link": "http://localhost:3000/r/25?t=4248"
    }
  ]
}
```

## search_conversations (keyword, phrase)

```json
{
  "query": "pelican roof tiles",
  "mode": "keyword",
  "mode_used": "keyword",
  "semantic_coverage": "none",
  "count": 1,
  "results": [
    {
      "interaction_id": 38,
      "title": "Pool house tile sample walkthrough",
      "occurred_at": "2026-07-18T09:00:00.000Z",
      "source": "upload",
      "kind": "other",
      "workspace_id": "strout_arch",
      "duration_sec": 120,
      "score": 0.01639,
      "matched_by": [
        "keyword"
      ],
      "keyword_hits": 1,
      "snippets": [
        {
          "start_sec": 42,
          "speaker": "Speaker 1",
          "text": "Let's use the pelican roof tiles sample for the pool house and see how it reads against the stucco.",
          "via": "keyword"
        }
      ],
      "deep_link": "http://localhost:3000/r/38?t=42"
    }
  ]
}
```

## list_interactions

```json
{
  "count": 3,
  "items": [
    {
      "interaction_id": 38,
      "title": "Pool house tile sample walkthrough",
      "kind": "other",
      "source": "upload",
      "occurred_at": "2026-07-18T09:00:00.000Z",
      "duration_sec": 120,
      "workspace_id": "strout_arch",
      "pipeline_status": "ready",
      "has_transcript": true,
      "embedded": true,
      "participants": [
        {
          "party_id": 1,
          "name": "Ben Strout"
        },
        {
          "party_id": 13,
          "name": "Carlos Mendes"
        },
        {
          "party_id": 3,
          "name": "Maria Delgado"
        }
      ],
      "deep_link": "http://localhost:3000/r/38"
    },
    {
      "interaction_id": 35,
      "title": "Ben Strout's Zoom Meeting",
      "kind": "meeting",
      "source": "zoom",
      "occurred_at": "2026-03-26T16:45:00.000Z",
      "duration_sec": 2873,
      "workspace_id": "strout_arch",
      "pipeline_status": "queued",
      "has_transcript": false,
      "embedded": false,
      "participants": [
        {
          "party_id": 1,
          "name": "Ben Strout"
        },
        {
          "party_id": 13,
          "name": "Carlos Mendes"
        },
        {
          "party_id": 3,
          "name": "Maria Delgado"
        }
      ],
      "deep_link": "http://localhost:3000/r/35"
    },
    {
      "interaction_id": 27,
      "title": "Mudroom layout with Maria",
      "kind": "meeting",
      "source": "zoom",
      "occurred_at": "2025-06-25T23:00:00.000Z",
      "duration_sec": 3794,
      "workspace_id": "strout_arch",
      "pipeline_status": "ready",
      "has_transcript": true,
      "embedded": true,
      "participants": [
        {
          "party_id": 1,
          "name": "Ben Strout"
        },
        {
          "party_id": 3,
          "name": "Maria Delgado"
        }
      ],
      "deep_link": "http://localhost:3000/r/27"
    }
  ]
}
```

## get_interaction (excerpt around 42 s)

```json
{
  "id": 38,
  "title": "Pool house tile sample walkthrough",
  "kind": "other",
  "source": "upload",
  "occurred_at": "2026-07-18T09:00:00.000Z",
  "duration_sec": 120,
  "workspace_id": "strout_arch",
  "tags": [
    "pricing",
    "investor",
    "site-visit"
  ],
  "summary": null,
  "pipeline_status": "ready",
  "participants": [
    {
      "party_id": 1,
      "name": "Ben Strout",
      "kind": "person",
      "speaker_label": "Speaker 1",
      "confidence": 0.95
    },
    {
      "party_id": 13,
      "name": "Carlos Mendes",
      "kind": "person",
      "speaker_label": null,
      "confidence": null
    },
    {
      "party_id": 3,
      "name": "Maria Delgado",
      "kind": "person",
      "speaker_label": null,
      "confidence": null
    }
  ],
  "projects": [
    {
      "project_id": 1,
      "name": "Heights Bungalow Addition",
      "status": "construction",
      "workspace_id": "strout_arch"
    }
  ],
  "transcript": {
    "segments": 13,
    "embedded_chunks": 1,
    "facts": 3,
    "excerpt": {
      "from_sec": 22,
      "to_sec": 62,
      "lines": [
        {
          "start_sec": 20.7,
          "end_sec": 26.5,
          "speaker": "Speaker 2",
          "speaker_party_id": null,
          "text": "The clients want a mudroom off the garage with a bench and cubbies for the kids."
        },
        {
          "start_sec": 30.6,
          "end_sec": 36.1,
          "speaker": "Speaker 2",
          "speaker_party_id": null,
          "text": "What does the timeline look like from your side?"
        },
        {
          "start_sec": 40.6,
          "end_sec": 48.3,
          "speaker": "Speaker 2",
          "speaker_party_id": null,
          "text": "Oakridge priced the framing package at about forty two thousand including labor."
        },
        {
          "start_sec": 42,
          "end_sec": 46.5,
          "speaker": "Speaker 1",
          "speaker_party_id": 1,
          "text": "Let's use the pelican roof tiles sample for the pool house and see how it reads against the stucco."
        },
        {
          "start_sec": 50.5,
          "end_sec": 55.5,
          "speaker": "Speaker 2",
          "speaker_party_id": null,
          "text": "Let's circle back to that at the end if we have time."
        },
        {
          "start_sec": 60.4,
          "end_sec": 69.4,
          "speaker": "Speaker 3",
          "speaker_party_id": null,
          "text": "We can do standing seam metal on the addition and keep the composition shingles on the main house."
        }
      ],
      "truncated": false,
      "next_start_sec": 90
    }
  },
  "deep_link": "http://localhost:3000/r/38?t=22"
}
```

## get_party (fuzzy name)

```json
{
  "party_id": 2,
  "kind": "person",
  "name": "Kevin McGuire",
  "emails": [
    "kevin.mcguire@example.com"
  ],
  "phones": [
    "+1 936 555 0142"
  ],
  "location": "Conroe, TX",
  "website": null,
  "notes": null,
  "affiliations": [],
  "roles": [
    {
      "workspace_id": "another_story",
      "workspace": "Another Story",
      "role": "contractor",
      "status": "active",
      "market": "Houston (Conroe)",
      "detail": "camera operator, drone",
      "started_at": null,
      "ended_at": null
    }
  ],
  "relationships": [
    {
      "kind": "works_with",
      "direction": "to",
      "party_id": 1,
      "name": "Ben Strout",
      "party_kind": "person",
      "workspace_id": "another_story",
      "first_seen": "2024-01-15T00:00:00.000Z",
      "last_seen": "2026-09-01T00:00:00.000Z",
      "evidence_count": 7,
      "notes": null
    }
  ],
  "projects": [
    {
      "project_id": 4,
      "name": "Conroe Shoot Day",
      "status": "scheduled",
      "workspace_id": "another_story",
      "role": "crew",
      "deep_link": "http://localhost:3000/projects/4"
    }
  ],
  "recent_interactions": [
    {
      "interaction_id": 40,
      "title": "Warehouse b-roll selects",
      "kind": "other",
      "source": "upload",
      "occurred_at": "2026-09-24T01:00:00.000Z",
      "duration_sec": 4348,
      "workspace_id": "another_story",
      "speaker_label": null,
      "deep_link": "http://localhost:3000/r/40"
    },
    {
      "interaction_id": 37,
      "title": "Kevin: quick check on the Conroe call time",
      "kind": "call",
      "source": "iphone_call",
      "occurred_at": "2026-06-17T06:00:00.000Z",
      "duration_sec": 120,
      "workspace_id": "another_story",
      "speaker_label": null,
      "deep_link": "http://localhost:3000/r/37"
    },
    {
      "interaction_id": 30,
      "title": "Ben Strout's Personal Meeting Room",
      "kind": "meeting",
      "source": "zoom",
      "occurred_at": "2025-10-12T05:00:00.000Z",
      "duration_sec": 1776,
      "workspace_id": "another_story",
      "speaker_label": "Kevin McGuire",
      "deep_link": "http://localhost:3000/r/30"
    },
    {
      "interaction_id": 26,
      "title": "Color pass sign-off",
      "kind": "meeting",
      "source": "zoom",
      "occurred_at": "2025-06-03T03:30:00.000Z",
      "duration_sec": 1681,
      "workspace_id": "another_story",
      "speaker_label": "Kevin McGuire",
      "deep_link": "http://localhost:3000/r/26"
    },
    {
      "interaction_id": 22,
      "title": "Brand story outline",
      "kind": "meeting",
      "source": "zoom",
      "occurred_at": "2025-01-14T20:00:00.000Z",
      "duration_sec": 4356,
      "workspace_id": "another_story",
      "speaker_label": "Kevin McGuire",
      "deep_link": "http://localhost:3000/r/22"
    },
    {
      "interaction_id": 11,
      "title": "Kevin: drone pass and call time",
      "kind": "call",
      "source": "iphone_call",
      "occurred_at": "2023-12-21T01:30:00.000Z",
      "duration_sec": 262,
      "workspace_id": "another_story",
      "speaker_label": null,
      "deep_link": "http://localhost:3000/r/11"
    },
    {
      "interaction_id": 10,
      "title": "Rough cut review with Sam",
      "kind": "meeting",
      "source": "zoom",
      "occurred_at": "2023-11-25T01:30:00.000Z",
      "duration_sec": 2169,
      "workspace_id": "another_story",
      "speaker_label": "Kevin McGuire",
      "deep_link": "http://localhost:3000/r/10"
    },
    {
      "interaction_id": 9,
      "title": "Conroe shoot day planning",
      "kind": "meeting",
      "source": "zoom",
      "occurred_at": "2023-10-24T03:30:00.000Z",
      "duration_sec": 3357,
      "workspace_id": "another_story",
      "speaker_label": "Kevin McGuire",
      "deep_link": "http://localhost:3000/r/9"
    }
  ],
  "facts": [
    {
      "fact_id": 9,
      "kind": "followup",
      "text": "If that changes, flag it early and we will adjust the plan.",
      "status": "open",
      "amount": null,
      "due_date": "2023-12-03",
      "confidence": 0.89,
      "role": "about",
      "project_id": 4,
      "interaction": {
        "interaction_id": 10,
        "title": "Rough cut review with Sam",
        "occurred_at": "2023-11-25T01:30:00.000Z",
        "quote_start_sec": 1072,
        "deep_link": "http://localhost:3000/r/10?t=1072"
      }
    },
    {
      "fact_id": 11,
      "kind": "commitment",
      "text": "Ben Strout will: I would like to deliver the final files in both ProRes and H.264.",
      "status": "open",
      "amount": null,
      "due_date": "2023-12-28",
      "confidence": 0.96,
      "role": "about",
      "project_id": null,
      "interaction": {
        "interaction_id": 11,
        "title": "Kevin: drone pass and call time",
        "occurred_at": "2023-12-21T01:30:00.000Z",
        "quote_start_sec": 45,
        "deep_link": "http://localhost:3000/r/11?t=45"
      }
    },
    {
      "fact_id": 24,
      "kind": "commitment",
      "text": "Sam Whitaker will: That is a good question. I do not know yet, but I can find out.",
      "status": "open",
      "amount": null,
      "due_date": "2025-02-03",
      "confidence": 0.81,
      "role": "about",
      "project_id": 4,
      "interaction": {
        "interaction_id": 22,
        "title": "Brand story outline",
        "occurred_at": "2025-01-14T20:00:00.000Z",
        "quote_start_sec": 755,
        "deep_link": "http://localhost:3000/r/22?t=755"
      }
    },
    {
      "fact_id": 32,
      "kind": "followup",
      "text": "Let's circle back to that at the end if we have time.",
      "status": "open",
      "amount": null,
      "due_date": "2025-10-25",
      "confidence": 0.98,
      "role": "about",
      "project_id": 4,
      "interaction": {
        "interaction_id": 30,
        "title": "Ben Strout's Personal Meeting Room",
        "occurred_at": "2025-10-12T05:00:00.000Z",
        "quote_start_sec": 780,
        "deep_link": "http://localhost:3000/r/30?t=780"
      }
    },
    {
      "fact_id": 40,
      "kind": "followup",
      "text": "The brand story should open on the founder walking the shop floor, not on a talking head.",
      "status": "open",
      "amount": null,
      "due_date": "2026-06-20",
      "confidence": 0.82,
      "role": "owner",
      "project_id": null,
      "interaction": {
        "interaction_id": 37,
        "title": "Kevin: quick check on the Conroe call time",
        "occurred_at": "2026-06-17T06:00:00.000Z",
        "quote_start_sec": 37,
        "deep_link": "http://localhost:3000/r/37?t=37"
      }
    },
    {
      "fact_id": 23,
      "kind": "decision",
      "text": "Let's schedule the color pass after the client approves the rough cut.",
      "status": "open",
      "amount": null,
      "due_date": null,
      "confidence": 0.62,
      "role": "about",
      "project_id": 4,
      "interaction": {
        "interaction_id": 22,
        "title": "Brand story outline",
        "occurred_at": "2025-01-14T20:00:00.000Z",
        "quote_start_sec": 4137,
        "deep_link": "http://localhost:3000/r/22?t=4137"
      }
    },
    {
      "fact_id": 10,
      "kind": "price",
      "text": "Let me share my screen so we are looking at the same thing.",
      "status": "open",
      "amount": null,
      "due_date": null,
      "confidence": 0.86,
      "role": "about",
      "project_id": null,
      "interaction": {
        "interaction_id": 11,
        "title": "Kevin: drone pass and call time",
        "occurred_at": "2023-12-21T01:30:00.000Z",
        "quote_start_sec": 240,
        "deep_link": "http://localhost:3000/r/11?t=240"
      }
    },
    {
      "fact_id": 12,
      "kind": "followup",
      "text": "Let's keep this meeting to thirty minutes if we can.",
      "status": "done",
      "amount": null,
      "due_date": "2023-12-30",
      "confidence": 0.63,
      "role": "about",
      "project_id": null,
      "interaction": {
        "interaction_id": 11,
        "title": "Kevin: drone pass and call time",
        "occurred_at": "2023-12-21T01:30:00.000Z",
        "quote_start_sec": 132,
        "deep_link": "http://localhost:3000/r/11?t=132"
      }
    },
    {
      "fact_id": 25,
      "kind": "followup",
      "text": "The Conroe shoot day starts at sunrise so we can get the drone pass before the wind picks up.",
      "status": "done",
      "amount": null,
      "due_date": "2025-01-23",
      "confidence": 0.92,
      "role": "owner",
      "project_id": 4,
      "interaction": {
        "interaction_id": 22,
        "title": "Brand story outline",
        "occurred_at": "2025-01-14T20:00:00.000Z",
        "quote_start_sec": 3139,
        "deep_link": "http://localhost:3000/r/22?t=3139"
      }
    }
  ],
  "deep_link": "http://localhost:3000/p/2"
}
```

## get_party (ambiguous name)

```json
{
  "ambiguous": true,
  "query": "ben",
  "candidates": [
    {
      "party_id": 1,
      "name": "Ben Strout",
      "kind": "person",
      "location": "Houston, TX",
      "emails": [
        "ben@example.com"
      ],
      "similarity": 0.36
    },
    {
      "party_id": 15,
      "name": "Nora Bennett",
      "kind": "person",
      "location": "Austin, TX",
      "emails": [
        "nora.bennett@example.com"
      ],
      "similarity": 0.21
    }
  ]
}
```

## get_project (fuzzy name)

```json
{
  "project_id": 1,
  "name": "Heights Bungalow Addition",
  "status": "construction",
  "address": "1412 Harvard St, Houston, TX",
  "notes": null,
  "workspace_id": "strout_arch",
  "workspace": "Strout Architecture",
  "created_at": "2026-10-24T23:49:35.791Z",
  "updated_at": "2026-10-24T23:49:35.791Z",
  "parties": [
    {
      "party_id": 3,
      "kind": "person",
      "name": "Maria Delgado",
      "role": "client",
      "deep_link": "http://localhost:3000/p/3"
    },
    {
      "party_id": 12,
      "kind": "org",
      "name": "Oakridge Builders",
      "role": "gc",
      "deep_link": "http://localhost:3000/p/12"
    },
    {
      "party_id": 13,
      "kind": "person",
      "name": "Carlos Mendes",
      "role": "site_super",
      "deep_link": "http://localhost:3000/p/13"
    }
  ],
  "interactions": [
    {
      "interaction_id": 38,
      "title": "Pool house tile sample walkthrough",
      "kind": "other",
      "source": "upload",
      "occurred_at": "2026-07-18T09:00:00.000Z",
      "duration_sec": 120,
      "deep_link": "http://localhost:3000/r/38"
    },
    {
      "interaction_id": 27,
      "title": "Mudroom layout with Maria",
      "kind": "meeting",
      "source": "zoom",
      "occurred_at": "2025-06-25T23:00:00.000Z",
      "duration_sec": 3794,
      "deep_link": "http://localhost:3000/r/27"
    },
    {
      "interaction_id": 25,
      "title": "Dormer and attic bedroom options",
      "kind": "meeting",
      "source": "zoom",
      "occurred_at": "2025-04-28T08:15:00.000Z",
      "duration_sec": 4346,
      "deep_link": "http://localhost:3000/r/25"
    },
    {
      "interaction_id": 19,
      "title": "Site visit: concrete pour prep",
      "kind": "other",
      "source": "upload",
      "occurred_at": "2024-09-29T01:15:00.000Z",
      "duration_sec": 2764,
      "deep_link": "http://localhost:3000/r/19"
    },
    {
      "interaction_id": 4,
      "title": "Bennett lake house kickoff",
      "kind": "meeting",
      "source": "zoom",
      "occurred_at": "2023-05-10T11:30:00.000Z",
      "duration_sec": 4451,
      "deep_link": "http://localhost:3000/r/4"
    },
    {
      "interaction_id": 3,
      "title": "Oakridge framing walkthrough",
      "kind": "other",
      "source": "upload",
      "occurred_at": "2023-03-30T11:30:00.000Z",
      "duration_sec": 3561,
      "deep_link": "http://localhost:3000/r/3"
    },
    {
      "interaction_id": 2,
      "title": "Delgado kitchen window review",
      "kind": "meeting",
      "source": "zoom",
      "occurred_at": "2023-02-15T13:30:00.000Z",
      "duration_sec": 2151,
      "deep_link": "http://localhost:3000/r/2"
    },
    {
      "interaction_id": 1,
      "title": "Heights bungalow: beam sizes and permit set",
      "kind": "meeting",
      "source": "zoom",
      "occurred_at": "2023-01-22T13:30:00.000Z",
      "duration_sec": 2387,
      "deep_link": "http://localhost:3000/r/1"
    }
  ],
  "facts": [
    {
      "fact_id": 3,
      "kind": "followup",
      "text": "Let's keep the roof pitch at six over twelve so it matches the original bungalow.",
      "status": "open",
      "amount": null,
      "due_date": "2023-05-24",
      "confidence": 0.79,
      "owner": {
        "party_id": 1,
        "name": "Ben Strout"
      },
      "about": {
        "party_id": 3,
        "name": "Maria Delgado"
      },
      "interaction": {
        "interaction_id": 4,
        "title": "Bennett lake house kickoff",
        "quote_start_sec": 2068
      }
    },
    {
      "fact_id": 28,
      "kind": "commitment",
      "text": "Maria Delgado will: That is a good question. I do not know yet, but I can find out.",
      "status": "open",
      "amount": null,
      "due_date": "2025-05-04",
      "confidence": 0.95,
      "owner": {
        "party_id": 3,
        "name": "Maria Delgado"
      },
      "about": {
        "party_id": 3,
        "name": "Maria Delgado"
      },
      "interaction": {
        "interaction_id": 25,
        "title": "Dormer and attic bedroom options",
        "quote_start_sec": 1530
      }
    },
    {
      "fact_id": 29,
      "kind": "followup",
      "text": "Energy code wants the attic at R38 if we insulate the ceiling, or we foam the roof deck.",
      "status": "open",
      "amount": null,
      "due_date": "2025-07-06",
      "confidence": 0.68,
      "owner": {
        "party_id": 3,
        "name": "Maria Delgado"
      },
      "about": {
        "party_id": 3,
        "name": "Maria Delgado"
      },
      "interaction": {
        "interaction_id": 27,
        "title": "Mudroom layout with Maria",
        "quote_start_sec": 1582
      }
    },
    {
      "fact_id": 43,
      "kind": "commitment",
      "text": "Maria Delgado will: Oakridge priced the framing package at about forty two thousand including labor.",
      "status": "open",
      "amount": null,
      "due_date": "2026-07-29",
      "confidence": 0.81,
      "owner": {
        "party_id": 3,
        "name": "Maria Delgado"
      },
      "about": {
        "party_id": 3,
        "name": "Maria Delgado"
      },
      "interaction": {
        "interaction_id": 38,
        "title": "Pool house tile sample walkthrough",
        "quote_start_sec": 40
      }
    },
    {
      "fact_id": 2,
      "kind": "price",
      "text": "I will send a follow-up email with the notes after this call.",
      "status": "open",
      "amount": null,
      "due_date": null,
      "confidence": 0.89,
      "owner": {
        "party_id": 1,
        "name": "Ben Strout"
      },
      "about": {
        "party_id": 3,
        "name": "Maria Delgado"
      },
      "interaction": {
        "interaction_id": 4,
        "title": "Bennett lake house kickoff",
        "quote_start_sec": 2968
      }
    },
    {
      "fact_id": 1,
      "kind": "followup",
      "text": "The plumbing rough-in needs to move eight inches to clear the new footing.",
      "status": "done",
      "amount": null,
      "due_date": "2023-05-14",
      "confidence": 0.86,
      "owner": {
        "party_id": 3,
        "name": "Maria Delgado"
      },
      "about": {
        "party_id": 3,
        "name": "Maria Delgado"
      },
      "interaction": {
        "interaction_id": 4,
        "title": "Bennett lake house kickoff",
        "quote_start_sec": 1704
      }
    },
    {
      "fact_id": 42,
      "kind": "commitment",
      "text": "Maria Delgado will: Let's circle back to that at the end if we have time.",
      "status": "done",
      "amount": null,
      "due_date": "2026-07-31",
      "confidence": 0.82,
      "owner": {
        "party_id": 3,
        "name": "Maria Delgado"
      },
      "about": {
        "party_id": 3,
        "name": "Maria Delgado"
      },
      "interaction": {
        "interaction_id": 38,
        "title": "Pool house tile sample walkthrough",
        "quote_start_sec": 50
      }
    },
    {
      "fact_id": 41,
      "kind": "decision",
      "text": "Who owns that next step? I want to make sure it does not fall through the cracks.",
      "status": "done",
      "amount": null,
      "due_date": null,
      "confidence": 0.62,
      "owner": {
        "party_id": 3,
        "name": "Maria Delgado"
      },
      "about": {
        "party_id": 3,
        "name": "Maria Delgado"
      },
      "interaction": {
        "interaction_id": 38,
        "title": "Pool house tile sample walkthrough",
        "quote_start_sec": 110
      }
    }
  ],
  "deep_link": "http://localhost:3000/projects/1"
}
```

## list_open_commitments

```json
{
  "count": 3,
  "items": [
    {
      "fact_id": 3,
      "kind": "followup",
      "text": "Let's keep the roof pitch at six over twelve so it matches the original bungalow.",
      "status": "open",
      "amount": null,
      "due_date": "2023-05-24",
      "confidence": 0.79,
      "workspace_id": "strout_arch",
      "owner": {
        "party_id": 1,
        "name": "Ben Strout"
      },
      "about": {
        "party_id": 3,
        "name": "Maria Delgado"
      },
      "project": {
        "project_id": 1,
        "name": "Heights Bungalow Addition",
        "deep_link": "http://localhost:3000/projects/1"
      },
      "source": {
        "interaction_id": 4,
        "title": "Bennett lake house kickoff",
        "occurred_at": "2023-05-10T11:30:00.000Z",
        "quote_start_sec": 2068
      },
      "deep_link": "http://localhost:3000/r/4?t=2068"
    },
    {
      "fact_id": 5,
      "kind": "followup",
      "text": "The dormer on the north side adds headroom in the attic bedroom without changing the front elevation.",
      "status": "open",
      "amount": null,
      "due_date": "2023-06-12",
      "confidence": 0.89,
      "workspace_id": "strout_arch",
      "owner": {
        "party_id": 3,
        "name": "Maria Delgado"
      },
      "about": {
        "party_id": 3,
        "name": "Maria Delgado"
      },
      "project": null,
      "source": {
        "interaction_id": 5,
        "title": "Permit status with Bayou City",
        "occurred_at": "2023-06-06T20:30:00.000Z",
        "quote_start_sec": 74
      },
      "deep_link": "http://localhost:3000/r/5?t=74"
    },
    {
      "fact_id": 6,
      "kind": "followup",
      "text": "I will confirm with the team and get back to you by Thursday.",
      "status": "open",
      "amount": null,
      "due_date": "2023-06-22",
      "confidence": 0.68,
      "workspace_id": "strout_arch",
      "owner": {
        "party_id": 3,
        "name": "Maria Delgado"
      },
      "about": {
        "party_id": 3,
        "name": "Maria Delgado"
      },
      "project": null,
      "source": {
        "interaction_id": 5,
        "title": "Permit status with Bayou City",
        "occurred_at": "2023-06-06T20:30:00.000Z",
        "quote_start_sec": 366
      },
      "deep_link": "http://localhost:3000/r/5?t=366"
    }
  ]
}
```

## propose_update (valid new_fact)

```json
{
  "queued": true,
  "review_id": 6,
  "item_type": "new_fact",
  "status": "open",
  "interaction_id": 38,
  "deep_link": "http://localhost:3000/review"
}
```

## propose_update (invalid proposal, rejected)

```json
{
  "error": "invalid_proposal",
  "message": "proposal does not match the new_fact shape",
  "issues": [
    {
      "path": "interaction_id",
      "message": "Expected number, received nan"
    },
    {
      "path": "kind",
      "message": "Invalid enum value. Expected 'commitment' | 'decision' | 'price' | 'followup' | 'issue' | 'preference' | 'other', received 'wish'"
    },
    {
      "path": "text",
      "message": "Required"
    }
  ]
}
```

## scope: another_story token asks for a phalanx recording

```json
{
  "query": "cap the pilot at one site ninety days security committee",
  "mode": "hybrid",
  "mode_used": "hybrid",
  "semantic_coverage": "full",
  "count": 3,
  "results": [
    {
      "interaction_id": 9,
      "title": "Conroe shoot day planning",
      "occurred_at": "2023-10-24T03:30:00.000Z",
      "source": "zoom",
      "kind": "meeting",
      "workspace_id": "another_story",
      "duration_sec": 3357,
      "score": 0.01639,
      "matched_by": [
        "semantic"
      ],
      "keyword_hits": 0,
      "snippets": [
        {
          "start_sec": 586,
          "speaker": "Kevin McGuire",
          "text": "Kevin McGuire: I would rather we over-communicate on this one than surprise anyone later. Ben Strout: We lost about a day to the weather but it should not move the delivery date. Kevin McGuire: The client wants a ninety second cut for the website and three fifteen second cuts for social. Can you send me the latest vers…",
          "via": "semantic"
        },
        {
          "start_sec": 2044,
          "speaker": "Ben Strout",
          "text": "Ben Strout: I will put the invoice together this week and send it over for review. Kevin is bringing the second camera body and the long lens for the interview setup. We lost about a day to the weather but it should not move the delivery date. Kevin McGuire: The number I quoted earlier was an estimate; the firm price c…",
          "via": "semantic"
        },
        {
          "start_sec": 367,
          "speaker": "Ben Strout",
          "text": "Ben Strout: We lost about a day to the weather but it should not move the delivery date. Kevin McGuire: Can you send me the latest version so I am not marking up an old one? Ben Strout: We shoot at sunrise so the drone pass clears before the wind, then move inside for the founder interview on the shop floor. Kevin McGu…",
          "via": "semantic"
        }
      ],
      "deep_link": "http://localhost:3000/r/9?t=586"
    },
    {
      "interaction_id": 22,
      "title": "Brand story outline",
      "occurred_at": "2025-01-14T20:00:00.000Z",
      "source": "zoom",
      "kind": "meeting",
      "workspace_id": "another_story",
      "duration_sec": 4356,
      "score": 0.01613,
      "matched_by": [
        "semantic"
      ],
      "keyword_hits": 0,
      "snippets": [
        {
          "start_sec": 3455,
          "speaker": "Sam Whitaker",
          "text": "Sam Whitaker: Sam can start the edit Monday once the footage is backed up to the drive and the cloud. Let's schedule the color pass after the client approves the rough cut. Can you send me the latest version so I am not marking up an old one? Give me one second, I am pulling up the file. Ben Strout: I will put the invo…",
          "via": "semantic"
        },
        {
          "start_sec": 1509,
          "speaker": "Kevin McGuire",
          "text": "Kevin McGuire: Before we wrap, is there anything else on your list? Can you send me the latest version so I am not marking up an old one? Sam Whitaker: I would rather we over-communicate on this one than surprise anyone later. The client wants a ninety second cut for the website and three fifteen second cuts for social…",
          "via": "semantic"
        },
        {
          "start_sec": 1047,
          "speaker": "Kevin McGuire",
          "text": "Kevin McGuire: Let's schedule the color pass after the client approves the rough cut. Give me one second, I am pulling up the file. What does the timeline look like from your side? Sam Whitaker: Who owns that next step? I want to make sure it does not fall through the cracks. Can you send me the latest version so I am …",
          "via": "semantic"
        }
      ],
      "deep_link": "http://localhost:3000/r/22?t=3455"
    },
    {
      "interaction_id": 10,
      "title": "Rough cut review with Sam",
      "occurred_at": "2023-11-25T01:30:00.000Z",
      "source": "zoom",
      "kind": "meeting",
      "workspace_id": "another_story",
      "duration_sec": 2169,
      "score": 0.01587,
      "matched_by": [
        "semantic"
      ],
      "keyword_hits": 0,
      "snippets": [
        {
          "start_sec": 1803,
          "speaker": "Kevin McGuire",
          "text": "Kevin McGuire: Can you send me the latest version so I am not marking up an old one? Give me one second, I am pulling up the file. The brand story should open on the founder walking the shop floor, not on a talking head. Ben Strout: I would rather we over-communicate on this one than surprise anyone later. Day rate for…",
          "via": "semantic"
        },
        {
          "start_sec": 975,
          "speaker": "Kevin McGuire",
          "text": "Kevin McGuire: The client wants a ninety second cut for the website and three fifteen second cuts for social. The client wants a ninety second cut for the website and three fifteen second cuts for social. Ben Strout: Let's circle back to that at the end if we have time. I think the realistic date is the end of next mon…",
          "via": "semantic"
        },
        {
          "start_sec": 1097,
          "speaker": "Ben Strout",
          "text": "Ben Strout: Kevin is bringing the second camera body and the long lens for the interview setup. If that changes, flag it early and we will adjust the plan. Can you send me the latest version so I am not marking up an old one? I will send a follow-up email with the notes after this call. The number I quoted earlier was …",
          "via": "semantic"
        }
      ],
      "deep_link": "http://localhost:3000/r/10?t=1803"
    }
  ]
}
```

## scope: another_story token looks up a phalanx-only person

```json
{
  "error": "not_found",
  "message": "no matching party within this token's scope"
}
```

