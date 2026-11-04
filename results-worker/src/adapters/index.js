/* Adapters by name, as a map's `feed.adapter` names them. Each one's `read({ fetch, map, prevToken })` returns
   { verdict, unchanged?, changed_token, election: {id, name, date}, source_status, official, source_updated, reporting,
   contests: [{ feed_id, feed_name, choices: [{name, votes}], total, reporting, updated, declared }], raw }.
   Election night, Nov 3: the first four ran Texas, Colorado and DC; the rest joined from the per-family source branches. */
import * as clarity from './clarity.js';
import * as harris from './harris.js';
import * as tx_sos from './tx_sos.js';
import * as dc from './dc.js';
import * as enhanced_voting from './enhanced_voting.js';
import * as la_county from './la_county.js';
import * as lvt from './lvt.js';
import * as ca_sos from './ca_sos.js';
import * as fl_dos from './fl_dos.js';
import * as vr_enr from './vr_enr.js';
import * as nyc_enr from './nyc_enr.js';
import * as md_sbe from './md_sbe.js';

export const ADAPTERS = { clarity, harris, tx_sos, dc, enhanced_voting, la_county, lvt, ca_sos, fl_dos, vr_enr, nyc_enr, md_sbe };
