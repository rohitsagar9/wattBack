# WattBack — 3-minute demo video script (4 acts)

Format: screen recording + voiceover. Hard stop at 2:55. AWS shots marked **[AWS]**
(judging requirement). Record **after** `eb deploy` so the live URL is real.

| # | Time | Screen | Voiceover (approx) |
|---|---|---|---|
| **ACT 1 — THE WASTE** ||||
| 1 | 0:00–0:15 | Phone camera on a dusty rooftop array, or satellite zoom into a Punjab field | "Thirty-two gigawatts of Indian rooftop solar. Fifty-three terawatt-hours a year. And almost nobody knows if their roof is actually producing what it should." |
| 2 | 0:15–0:40 | Live story page `/` — hero "₹1,100 crore dust tax", scroll the 17 leak cards quickly | "Three to ten percent just vanishes — dust, heat, shade, dead strings, silent outages. WattBack names every one of the seventeen places it goes. This is not a metaphor: ₹1,100 crore a year, on the table." |
| **ACT 2 — THE ENGINE** ||||
| 3 | 0:40–1:10 | `/onboard/` — pick "Bhadla Solar Park" from the dropdown, map flies to the site, click through to step 3: extraction numbers appear (ERA5 ✓ Atlas ✓ PVGIS ✓ horizon ✓), shading view draws sun path over terrain | "Onboarding takes one coordinates entry. The engine fans out to ERA5 reanalysis, the Global Solar Atlas, and the EU Commission's PVGIS — then draws today's sun path over your terrain silhouette, live." |
| 4 | 1:10–1:40 | `/app/?site=bmt` — expected-vs-actual chart, hover a day; loss waterfall + soiling gauge; banner "UNEXPLAINED 0.09%" | "BMT Punjab, 56 kilowatts, six years of real generation. Expected versus actual, then the waterfall: heat took 6.8%, the inverter 3.6%, dust, cables, angle. After naming everything — 0.09% unexplained. The books balance, exactly." |
| 5 | 1:40–2:05 | `/app/analytics/` — year bars, PR heatmap lighting up months; `/app/cleaning/` — counterfactual + action ladder "ACT: wash panels" | "The heatmap shows six years of performance by month. The cleaning page turns it into money: wash now, worth ₹X — or wait for rain. And the action ladder reads your own data so the first red ACT is the job for today." |
| **ACT 3 — ON AWS** ||||
| 6 | 2:05–2:25 | **[AWS]** EB console: environment health green → application versions (S3) → `eb logs --stream` CloudWatch lines scrolling | "The whole thing runs on AWS Elastic Beanstalk — single instance, free tier. Every `eb deploy` lands in S3 as a new version. Logs stream straight into CloudWatch." |
| 7 | 2:25–2:45 | **[AWS]** run `publish_digest` in terminal → SNS console topic → email inbox with the digest; DynamoDB console showing `wattback-systems` table | "Amazon SNS emails the owner: yesterday's generation, active outages, wash-worth-rupees, and the top loss driver. Onboarded systems dual-write to DynamoDB — same app, cloud or laptop, no code branches." |
| **ACT 4 — CLOSE** ||||
| 8 | 2:45–2:55 | `pytest -q` green (50 passed) → impact strip ₹1,100 cr → repo URL + "AI: opencode" | "Fifty tests green. Scale 3% recovery across India: ₹1,100 crore a year back. Django, pvlib, LightGBM, AWS — and opencode. Code's public: try it on your own roof." |

## Recording checklist

- [ ] `eb open` works in a signed-out/incognito window (real EB URL in address bar)
- [ ] AWS console tabs pre-opened: EB environment · S3 versions · CloudWatch · SNS · DynamoDB
- [ ] `publish_digest` run once before recording so the email is already in the inbox
- [ ] Story, onboard, dashboard, analytics, cleaning all loaded once (caches warm)
- [ ] pytest run captured green (50 passed) — record this take first
- [ ] Under 3:00 · YouTube unlisted/public · link opens signed-out
- [ ] Voiceover paced to act boundaries; cut hard at 2:55
