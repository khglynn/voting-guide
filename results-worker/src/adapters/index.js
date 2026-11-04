/* Adapters by name, as a map's `feed.adapter` names them. Each one's `read({ fetch, map, prevToken })` returns
   { verdict, unchanged?, changed_token, election: {id, name, date}, source_status, official, source_updated, reporting,
   contests: [{ feed_id, feed_name, choices: [{name, votes}], total, reporting, updated, declared }], raw }.
   Later adapters (enhanced_voting, lvt, the custom JSONs, csv, html_table) join this list in sub-phases 5 and 6. */
import * as clarity from './clarity.js';
import * as harris from './harris.js';
import * as tx_sos from './tx_sos.js';
import * as dc from './dc.js';
import * as la_county from './la_county.js';

export const ADAPTERS = { clarity, harris, tx_sos, dc, la_county };
