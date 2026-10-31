# HANDOVER BRIEF: Monkey Baa Next Steps board storyboard

**Context**
Kevin is preparing the November 2026 Monkey Baa Theatre Company board meeting. The organisation is going through complex change: the Artistic Director and Executive Director roles are merging into one Artistic Director & CEO role, and there are changes to the business, artistic, financial and NCTI (National Children's Theatre Initiative) models plus a new strategy. Kevin wants to send board members a highly visual, animated, scrollable storyboard they can read on their own, instead of a dense board paper.

**What we are producing**
"Monkey Baa: Next Steps", a single self-contained HTML file that board members scroll through, with chapter tabs across the top to jump between sections.

**Where it is up to**
The navigation framework, the Monkey Baa brand styling and the full People model chapter (21 screens) are built and working. The other six chapters are title screens marked "In development". Kevin is moving the work from Claude Code to Cowork.

**Files (GitHub: dupreez1979-sketch/General-Internal, branch master)**
- `board-storyboard/index.html`: the storyboard. Story data is in the `NODES`, `LAYOUT`, `PARENTS`, `CAM` and `STEPS` arrays in the script.
- `CLAUDE.md`: the project rules (golden rule, story structure, design system, writing style). Treat as binding.
- `board-storyboard/CONTENT-NOTES.md`: Kevin's early chapter notes.

**Current version: the People model screen script (verbatim)**
Each line is one screen. The org chart stays on screen and morphs and zooms between them.
1. Today, two leaders report to the Board. (current chart, full view)
2. Next, one leader reports to the Board. (chart rearranges into the new structure)
3. Two roles at the top. (zoom to AD and ED)
4. Become one: Artistic Director & CEO. (ED slides into AD and disappears)
5. The Executive Director role holds 42 core duties. (42 dots)
6. Where those duties go. (dots split: 3 move to the Executive Producer, 7 stop, 32 to be reallocated)
7. One leader at the top. (zoom out, AD & CEO highlighted)
8. The Senior Producer… (zoom to that role)
9. …steps up to Executive Producer.
10. The Head of Production…
11. …steps up to General Manager.
12. Marketing, finance and production now report to the General Manager.
13. Two promotions share the load. (zoom out)
14. Interim arrangements (placeholder, content to come)
15. Recruitment timeline (placeholder, content to come)
16. Three new supports for the Board. (Treasurer, HR Advisor, Secretary)
17. Fundraising support for the Artistic Director & CEO.
18. Support built in around the top. (zoom out)
19. Today, the artistic team sits apart. (colour by department)
20. Next, one artistic company. (every role turns the same colour)
21. The new people model. (complete chart)

**Source data for the People model** (Kevin's "Scenario comparison" export, Current (August 2026) vs AD & CEO Model)
- Current: Board > Artistic Director (> Senior Producer > Associate Producer) and Executive Director (> Head of Production > Stage Managers > ASMs, Production Managers; > Marketing Manager; > Finance Manager).
- New: Board (with Treasurer, HR Advisor, Secretary alongside) > Artistic Director & CEO (with Fundraising Support Consultant alongside) > Executive Producer > Producer; and > General Manager > Marketing Manager, Finance Manager, Stage Managers > ASMs, Production Managers. Every role moves into the artistic department.
- Executive Director's 42 primary duties: 3 to the Executive Producer, 7 removed, 32 unassigned.

**Decisions locked in**
- One idea per screen. This is the golden rule and overrides everything. One short line of text at most. No stacked headings, no eyebrow, title and intro patterns, no grids of text boxes, no bullet lists. Kevin explicitly called out Claude's habit of information overload.
- Story pattern: open each chapter on an overview visual, zoom into one part and tell its small story one screen per step, zoom back out to the overview, then move to the next part. The overview builds up as each part is covered.
- Chapters, in order: Background (the last 12 months, factual), People model, Business model (Business Model Canvas, current vs new), Artistic model (new programming cycle), Financial model (2026 to 2028, growth scenarios), NCTI model (change in recommendation, service delivery, Social Theatre Pilot, Investment Fund), New strategy (draft).
- Tabs across the top show where the reader is and what they have seen. It works as one continuous scroll and by jumping. Arrow keys and corner buttons step one screen at a time.
- Design system: the Monkey Baa Brand Overview (2022, in Kevin's Google Drive). Use its 14 colours, black text wherever possible, Gellix type set large and tight, brand shapes rather than characters for an adult audience. Each chapter opener uses a different brand colour. Full values are in `CLAUDE.md`.
- No em-dashes. Australian English. Plain, short sentences.

**Tried and rejected**
- The first framework: nine generic sections, each with an eyebrow label, heading, intro sentence and a grid of cards (stat cards, pressure chips, risk matrix, before and after table). Rejected as information overload. Do not bring back that layout.
- Chapter structure invented by Claude (Where we are, Why change, Vision, Operating design, Roadmap, Risks, Board asks). Replaced by Kevin's seven chapters above.

**Open questions**
- Kevin may want the design system he built in Claude Design rather than the 2022 Brand Overview. Claude Code could not reach it from a cloud session. Get the files from Kevin or open it directly in Cowork, then restyle.
- Gellix font files are needed. The file currently uses Outfit as a stand-in.
- Screen 6 shows "32 to be reallocated" from the Executive Director's duties. Does Kevin want that in front of the Board yet?
- The Strategic Advisor role (no reporting line in the scenario) and the dotted lines (Marketing Manager to Executive Producer, Finance Manager to AD & CEO) are left out. Include them?
- Content still needed: interim arrangements, recruitment timeline, and all material for the other six chapters.

**Immediate next step**
Confirm which design system to use (the 2022 Brand Overview or Kevin's Claude Design system), then gather content for the next chapter Kevin wants to build.
