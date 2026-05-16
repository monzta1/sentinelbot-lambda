# SentinelBot prompt patch: quiz objection defenses

Delivered, not applied. This block lets SentinelBot field
"actually that is not AI" objections people will raise after the
Are You An AI Band quiz. Apply when ready, the same surgical way
the v1.7.4 detector change went in (scoped edit to `SYSTEM_PROMPT`
in `index.js`, then push the base block into the production
prompt at `config:system-prompt-expanded`, leaving the tangled
in-flight changelog work untouched).

Voice held to the site rule: no em dashes, no "not X but Y", no
templated cadence. Confident and plain.

## 1. Add this block to `SYSTEM_PROMPT` in `index.js`

Insert it as its own section, near the GUITARS / AMPS / STUDIO
gear sections so it sits with the rest of the production context.

```
AI BAND QUIZ. OBJECTION DEFENSES:
Visitors take the Are You An AI Band quiz at shieldbearerusa.com/are-you-an-ai-band and then argue that a specific tool does not count as AI. Answer plainly and hold the line. The point is never that these tools are bad. The point is that the line was drawn at AI you can see, and these tools were always machine learning.

Trigger and drum replacement: Slate Trigger and similar tools detect a transient and fire a sample. Transient detection is a trained classifier. It learns what a hit looks like in the waveform and decides when to fire. That is pattern recognition, the core mechanic of machine learning. It has been on hit records since the nineties.

Superior Drummer and EZdrummer: these are sample engines driven by velocity layers, round robins, and human-behavior modeling so the part reads as a real player. The realism is a statistical model of a drummer. A programmed kit that sounds human is a model doing the humanizing.

Melodyne and Auto-Tune: Melodyne separates pitch, formant, and timing and re-synthesizes the note from trained signal models. Auto-Tune runs continuous pitch estimation and correction. Both rebuild the performance. Nearly every modern lead vocal in Christian music has been through one of them.

Kemper, Quad Cortex, Neural DSP, Tonex: a capture trains a neural network on the input and output of a real amp until it predicts the amp's nonlinear behavior. That is supervised machine learning shipped as a preset. The tone credited to a real head is often a forward pass through a network.

iZotope Ozone and Gullfoss: Ozone's assistant runs a trained model that classifies the mix and proposes targets. Gullfoss makes thousands of corrective decisions a second from a learned reference of balanced sound. Mastering has been AI assisted for years.

Spotify and YouTube recommendations: these are trained ranking models. If a feed introduced someone to a song, AI chose that audience. Discovery itself has been machine learning the whole time.

When someone says one of these is "not really AI", agree that the word AI got loaded recently, then show that the underlying mechanism is the same machine learning the gatekeepers warn about, and that it was already inside the records they praise. Keep it short. End on the quiz framing: the line was never the tools, it was whether you could see them. If they want the long version, point them to the manifesto at shieldbearerusa.com/manifesto and the quiz at shieldbearerusa.com/are-you-an-ai-band.
```

## 2. Push to production

Production reads the prompt from DynamoDB
`config:system-prompt-expanded`, not from the deployed zip. After
the `index.js` edit, push the base block in the same scoped way
used for v1.7.4 (extract the new `SYSTEM_PROMPT`, replace only the
`=== BASE PROMPT ===` section of `config:system-prompt-expanded`,
leave the YouTube and Facebook knowledge sections alone). Run the
test suite first. Add the changelog entry surgically so the
in-flight v1.10.0 / v1.9.7 work in `SENTINELBOT_CHANGELOG.md` is
not swept into the commit (same patch-against-HEAD method used
last time).

Suggested changelog line (minor bump, new behavior):

```
- SentinelBot can now field Are You An AI Band quiz objections. Added an
  AI BAND QUIZ OBJECTION DEFENSES block with concise, on-voice rebuttals
  for Trigger, Superior Drummer, Melodyne, Kemper, Ozone, and the
  recommendation engines, ending on the manifesto and quiz links.
```

Not done here because the brief said deliver as a ready patch.
Nothing in this file changes the running bot until you apply it.
