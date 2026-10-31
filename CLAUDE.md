# Monkey Baa Next Steps: board storyboard

A scrollable, animated visual story for the November 2026 board meeting. Lives in `board-storyboard/`. Content notes are in `board-storyboard/CONTENT-NOTES.md`.

## The golden rule: one idea per screen

This overrides everything else. Every screen communicates exactly one simple idea, visually.

- One idea. If a screen needs two points, it is two screens.
- One short line of text at most (a statement, not a heading plus subheading plus body). Often a single number or a few words.
- The visual carries the meaning. Text supports it, never the other way round.
- No stacked headings, no eyebrow + title + lede + cards pattern, no grids of text boxes, no bullet lists.
- No information overload. When in doubt, cut. Then cut again.
- Generous empty space. The idea sits alone in the middle of the screen.
- Test: could a board member grasp the screen in three seconds without reading anything else? If not, simplify or split it.

## Story structure: zoom out, zoom in, zoom out

Big picture first, then one small story at a time, then back to the big picture.

1. **Overview.** Each chapter opens on a single visual of the whole (e.g. the full new org chart).
2. **Zoom in.** The camera moves into one part of that visual and tells one small story (e.g. AD and ED merging into the AD & CEO role). Each step of that small story is its own screen.
3. **Zoom out.** Return to the overview with that part now resolved or highlighted, so the viewer sees where it fits.
4. **Next part.** Zoom into the next part. Repeat.
5. **Close the chapter** on the complete overview, all parts now explained.

The overview visual is the common thread: it should visibly accumulate understanding as each part is covered.

## Chapters (from early notes)

Background, People model, Business model, Artistic model, Financial model, NCTI model, New strategy.

## Design system: Monkey Baa Brand Overview

Source: `Monkey_Baa_brand_overview (1).pdf` in Kevin's Google Drive (2022). Always use it. The colours are defined as `--mb-*` CSS variables in `board-storyboard/index.html`.

- **Neutrals:** Neutral 1 #F0DBD3, Neutral 2 #EFCEBE, Neutral 3 #CE9788, Grey 1 #CBD1D5, Grey 2 #949695
- **Darks:** Dark Teal #1B5A68, Dark Red #99351E, Dark Green #328276, Gold #B36E24
- **Brights:** Magenta #FF4C80, Yellow #ECEB00, Pink #FF92B1, Orange #FF7552, Green #6FC483
- **Contrast:** black and white
- The palette flexes; no single corporate colour. Each chapter opener takes its own brand colour.
- **Text:** black text wherever possible. White only where contrast needs it.
- **Type:** Gellix (Bold, SemiBold, Medium) with Sebenta Regular. Gellix at large scale with tight kerning and tight leading. The file loads Outfit as a web stand-in until Gellix font files are supplied.
- **Logo:** always black, never reversed out.
- **Shapes:** for an adult audience like the Board, use the brand shapes rather than the characters.

## Writing style

- Never use em-dashes.
- Plain, direct language. Short sentences. No jargon unless the board already uses it.
- Australian English spelling.

## Navigation

- Chapter tabs across the top, showing where the viewer is and what they have seen.
- Works as one continuous scroll, and also by jumping between chapters.
- Single self-contained HTML file so it can be emailed or hosted.
