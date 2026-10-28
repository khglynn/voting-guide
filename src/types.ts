/* Shapes produced by scripts/build-data.mjs. Field names follow SCHEMA.md. */
export type Confidence = 'verified' | 'sourced' | 'unverified';
export type Lean = 'left' | 'lean_left' | 'neutral' | 'lean_right' | 'right';

export interface Src { name: string; url: string }

export interface Candidate {
  name: string;
  short: string;
  party: string | null;
  parties: string[];
  incumbent: boolean;
  website: string | null;
  website_confidence: Confidence;
  background: string | null;
  own_words: { text: string; is_quote: boolean; source: string | null; source_label?: string | null }[];
  lwv_status: string | null;
  lwv_url: string | null;
  /* "none_found" when a real search found no statement; own_words_checked says where and when. */
  own_words_status?: 'none_found';
  own_words_checked?: { on: string; where: string[] };
  /* Official job reviews and bar ratings, for judges (retention and judicial races). */
  evaluations?: Evaluation[];
}

export interface Evaluation {
  by: string;
  by_short: string;
  kind: 'official_commission' | 'bar_group' | 'bar_poll' | 'bar_committee';
  rating: string;
  verdict: 'favorable' | 'unfavorable' | 'mixed' | 'none';
  vote: string | null;
  survey: {
    question: string | null;
    attorneys: SurveyRow | null; non_attorneys: SurveyRow | null; judges: SurveyRow | null;
    report_url: string | null; caution: string | null;
  } | null;
  vote_note: string | null;
  survey_note: string | null;
  noted_strength: string | null;
  noted_concern: string | null;
  url: string;
  verified_on: string | null;
  confidence: Confidence;
}

/* One group's answers to the review's yes-or-no question. n counts everyone who answered it,
   including "no opinion", so yes and no need not add to 100. */
export interface SurveyRow { yes_pct: number; no_pct: number | null; n: number | null }

/* A short note on a known confusion point, shown once where it applies. */
export interface HeadsUp { text: string; applies_to: string; source?: string | null }

export interface Contest {
  kind: 'contest';
  id: string;
  state: string;
  level: 'federal' | 'state' | 'county' | 'city' | 'judicial' | 'school' | 'special_district';
  office: string;
  district: string | null;
  scope_plain: string;
  every: boolean;
  office_explainer: string | null;
  why_it_matters: string | null;
  vote_for: number;
  /* Ranked choice: the voter ranks up to rank_up_to candidates (the ballot's own number,
     write-in line included) and `winners` seats are filled. rcv_how is a race-specific
     counting sentence when the default would be wrong (DC at-large). */
  ranked_choice: boolean;
  rank_up_to: number | null;
  winners: number;
  rcv_how: string | null;
  rcv_url: string | null;
  incumbent: string | null;
  open_seat: boolean | null;
  term_years: number | null;
  is_retention: boolean;
  /* Short distinguishing label ("Seat 3", "Subdistrict 4") when one office repeats on a ballot. */
  seat_label?: string;
  candidates: Candidate[];
  sources: Src[];
  confidence: Confidence;
}

export interface Measure {
  kind: 'measure';
  id: string;
  state: string;
  level: string;
  jurisdiction: string;
  number: string;
  official_title: string | null;
  /* 2 to 5 plain words naming what it does ("Parks bond, $260M"), for rows and the cheat sheet */
  short_title?: string | null;
  plain_summary: string | null;
  yes_means: string | null;
  no_means: string | null;
  current_law: string | null;
  fiscal_impact: string | null;
  pass_threshold: string | null;
  referred_by: string | null;
  confusing_wording_note: string | null;
  supporters_case: { text: string; source: string | null } | null;
  opponents_case: { text: string; source: string | null } | null;
  official_text_url: string | null;
  official_guide_url: string | null;
  explainers: { source: string; title: string | null; url: string }[];
  confidence: Confidence;
  links: string[];
}

export type Item = Contest | Measure;

export interface Endorser {
  id: string;
  name: string;
  short: string;
  type: string;
  lean: Lean | null;
  lean_basis: string | null;
  lean_note: string | null;
  guide_url: string | null;
  default_on: boolean;
  endorses_candidates: boolean;
  endorses_measures: boolean;
  /* For party organizations: the party they speak for ("Democratic", "Working Families"). */
  party?: string;
  lean_basis_kind?: 'outside_rating' | 'party' | 'mission';
  /* A paper whose endorsements sit behind a paywall we couldn't read. Picks seen only secondhand
     are out of the data; the app shows a note asking subscribers to send them. Absent = false. */
  paywall?: true;
  /* false hides the paywall note for this source (absent = show it). */
  paywall_note_ok?: false;
  /* This source's own wording for the note, when the data gives one; otherwise the app's. */
  paywall_note?: string;
  /* A source whose site shows a bot check to anything that isn't a browser (Oct 25): read like a paywall,
     "Couldn't read". blocked_note is its one line; absent, the app's. Absent = not blocked. */
  blocked?: true;
  blocked_note?: string;
  /* The place ids in the source's own geography, when it names any (a regional paper, even one that
     also picks statewide races, or a county party). Absent when it names none, and for a party or
     group whose geography names its state (a statewide group). "Not checked yet" on a district race
     needs the ballot's place in here. */
  home_places?: string[];
  /* In memory only, never in the data (model/adds.ts, Oct 28): a source this device took in from its request's
     branch preview before the merge. The sources sheet says it's new here and still being checked. */
  preview?: true;
}

export interface Endorsement {
  s: 'endorsed' | 'no_position' | 'not_found';
  c: string[] | null;
  note: string | null;
  why: string | null;
  url: string | null;
  date: string | null;
  conf: Confidence;
  both?: boolean;
  /* A not_found row whose record says the source's page couldn't be read (a paywall or an access
     block). A paywalled paper's row then shows its paywall note instead of "No endorsements found". */
  unreadable?: true;
}

export interface Deadline { method?: string; date: string | null; rule: string; source?: string; time?: string | null }

export interface HowTo {
  state: string;
  /* where the polls are, set by plan.localHowto: one zone for a known place, every zone the
     state spans for a statewide-only ballot */
  zones?: string[];
  /* set by plan.localHowto when the ballot spans counties and the voter's county isn't known: each county's
     tools, so the plan can offer them labeled (Oct 28) */
  county_links?: { county: string; lookups: Lookups }[];
  election_date: string;
  last_verified: string | null;
  official_site: Src;
  voting_model: 'all_mail' | 'mail_to_all_plus_in_person' | 'in_person_first' | string;
  model_plain: string | null;
  registration: {
    check_url: string | null;
    /* vote.gov's register page for this state, and the vote.gov page that confirms the pattern */
    register_url?: string;
    register_url_source?: string;
    deadlines: { method: string; date: string | null; rule: string; source: string | null }[];
    same_day_registration: boolean | null;
    same_day_notes: string | null;
    still_possible_now: string | null;
  };
  mail_ballot: {
    who_gets_one: string | null;
    request_deadline: { date: string | null; rule: string; source: string | null } | null;
    return_deadline: { date: string; rule: 'received_by' | 'postmarked_by' | string; time: string | null; source: string | null };
    return_options: string[] | null;
    postage: string | null;
    signature_witness_rules: string | null;
    tracking_url: string | null;
    cure_process: string | null;
    mail_cutoff_advice: string | null;
    drop_box_lookup_url: string | null;
  };
  early_in_person: {
    available: boolean;
    start: string | null;
    end: string | null;
    hours_note: string | null;
    vote_centers: boolean | null;
    lookup_url: string | null;
  };
  election_day: {
    polls_open: string;
    polls_close: string;
    in_line_rule: string | null;
    vote_centers: boolean | null;
    lookup_url: string | null;
  };
  id_rules: { required: string; accepted: string[]; no_id_option: string | null };
  in_the_booth: {
    phones: string;
    phones_detail: string | null;
    /* Where phones are "restricted": the rule in one plain line for My plan, from phones_detail. */
    phones_short?: string | null;
    notes_allowed: string;
    notes_detail: string | null;
    ballot_selfies: string | null;
    apparel_rule: string | null;
  };
  gotchas: string[];
  /* each gotcha's fix in one line, in the same order as gotchas (null where none was written) */
  gotcha_shorts?: (string | null)[];
  /* `short`: the quick answer, one sentence; `actions`: up to 2 official links from this state file */
  situations?: { id: string; question: string; answer: string; steps: string[] | null; deadline: string | null; source: string | null; confidence: Confidence; short?: string; actions?: HelpAction[] }[];
  /* a better official sample-ballot lookup than any source named like one, for a statewide-only ballot */
  sample_ballot_url?: string;
  sources: Src[];
  heads_up?: HeadsUp[];
  judicial_review?: JudicialReview | null;
}

/* How judges get on this state's ballot and what their reviews mean, in plain words. */
export interface JudicialReview {
  how_judges_get_here: string | null;
  who_reviews: string | null;
  what_the_rating_means: string | null;
  what_it_doesnt_mean: string | null;
  to_keep_a_judge: string | null;
  history: string | null;
  read_one: { label: string; url: string } | null;
  sources: Src[];
}

export interface StateBundle {
  state: string;
  name: string;
  howto: HowTo;
  order: string[];
  items: Item[];
  endorsers: Endorser[];
  endorsements: Record<string, Record<string, Endorsement>>;
}

export interface HelpAction { label: string; url: string }

export type Lookups = { early_in_person?: string; election_day?: string; drop_box?: string };
/* One county's where-to-vote tools for a place that spans counties. `zips`: the place's ZIPs that lie wholly
   in this county (by the Census's ZIP-to-county file and the place's own research both), so a ZIP alone can
   name the county. */
export interface CountyLinks { county: string; zips: string[]; lookups: Lookups; source: string; confidence: Confidence }
/* A county's own answer to a state question: what it gives replaces the state's (steps: null means none). */
export interface PlaceSituation { id: string; short?: string; answer?: string; steps?: string[] | null; source: string; confidence: Confidence }
export interface OfficeLine { label: string; phone: string; hours?: string }

/* `hours_short`: the county's early voting hours in one line ("Travis County sites are open 7 AM to 7 PM every day.") */
export interface PlaceEarly { start: string; end: string; hours_note: string | null; hours_short?: string; lookup_url: string | null; source: string | null; confidence: string }

export interface PlaceBundle {
  id: string;
  label: string;
  state: string;
  counties: string[];
  /* `phone_label` names the main phone ("General line") when `lines` adds labeled direct ones (Oct 28) */
  county_election_office: { name: string; url: string | null; phone: string | null; phone_label?: string; lines?: OfficeLine[]; hours?: string; source?: string } | null;
  sample_ballot_url: string | null;
  zips: string[];
  zip_caveats: string | null;
  notes: string | null;
  county_label?: string | null;
  district_finders?: { office_match: string; label: string; url: string }[];
  heads_up?: HeadsUp[];
  /* the county's own early-voting window, when it differs from the state's; plan.ts prefers it */
  early_in_person?: PlaceEarly;
  /* the county's own where-to-vote tools; plan.ts prefers them over the state's */
  lookups?: Lookups;
  /* a place across county lines keeps each county's tools (Oct 28): plan.localHowto uses the voter's county's
     when it knows the county, and lists each county's, labeled, when it doesn't */
  by_county?: CountyLinks[];
  /* the county's own answers to the state's common questions, by the state situation's id (Oct 28) */
  situations?: PlaceSituation[];
  /* the official pages behind the place's own facts (notes, office lines, answers); not shown */
  sources?: Src[];
  order: string[];
  local: string[];
  items: Item[];
  endorsers: Endorser[];
  endorsements: Record<string, Record<string, Endorsement>>;
  /* the district maps this place's ballot reads after an address lookup (data/maps/, model/maps.ts) */
  maps?: MapMeta[];
}

/* One rule of a district map: the races it settles (office, and scope when the rule names one, both
   regexes) and the district a feature's answer names ("Precinct {commissioner}"). */
export interface SettleRule { office: string; scope?: string; district: string }
/* A district map as the place bundle lists it (build-data, from data/maps/{area}/{kind}.json). The
   boundaries themselves (`file`, TopoJSON under /data/) load only after an address lookup. */
export interface MapMeta {
  kind: string;
  file: string;             // "maps/travis-county-tx/precincts.topo.json", under /data/
  bytes: number;
  name: string;             // "council district": what the address box calls it
  title: string;
  county: string | null;    // the county the map covers, when it is one county's
  settles: SettleRule[];
  shows: string | null;     // a line naming the feature itself: "Your voting precinct: {label} (Travis County)."
  source_url: string;
  source_org: string;
  layer_dated: string | null;
  fetched: string;
}

/* How covered a ballot is, counted by build-data (scripts/coverage.mjs) over the ballot the app builds for
   that place, or for the state alone. local_* are the place's own sources (its home_places), or for a
   state its statewide ones; checked is the newest endorsement row's date. */
export interface Coverage {
  sources: number;
  with_picks: number;
  local_sources: number;
  local_with_picks: number;
  checked: string | null;
}
export interface PlaceCoverage extends Coverage {
  /* the place's own races a voter decides, and how many of them have a pick from anyone */
  local_races: number;
  local_races_with_picks: number;
}
export interface Index {
  generated: string;
  states: Record<string, { name: string; as_of: string | null; election_date: string; official_site: Src; places: string[] } & Coverage>;
  places: Record<string, { label: string; state: string; counties: string[]; local_count: number; maps?: string[] } & PlaceCoverage>;
  zips: Record<string, string[]>;
  /* true when data/get-involved.json was bundled (the app never asks for a file that isn't there) */
  involved?: boolean;
  /* the parties whose own organizations have endorsements in the data, A to Z ("A party" before a ZIP) */
  parties?: string[];
}
