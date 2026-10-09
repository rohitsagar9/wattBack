# WattBack — 3-minute demo video script

Format: screen recording + voiceover. Under 3:00 (cut hard at 2:55).
Must show AWS (judging requirement) — marked **[AWS]**.
Record after `eb deploy` so the live URL is real.

| # | Time | Screen | Voiceover (approx) |
|---|---|---|---|
| 1 | 0:00–0:18 | Phone/roof shot or satellite of a rooftop + ₹ bill | "32 gigawatts of Indian rooftop solar. 53.8 terawatt-hours a year. And almost nobody knows if their roof is actually producing what it should — 3 to 10% just vanishes." |
| 2 | 0:18–0:35 | Repo + `pytest` running green (38 tests) | "WattBack answers that: what your system *should* have produced, and exactly where each missing unit went. Six years of real generation from two systems, physics-modelled day by day." |
| 3 | 0:35–1:05 | Live dashboard `/` — expected-vs-actual chart, hover days | "This is BMT Punjab, 56 kilowatts. Expected versus actual for September: 5,670 expected, 4,917 measured — and after naming every loss, only 0.09% is unexplained." |
| 4 | 1:05–1:30 | Loss waterfall + soiling gauge + counterfactual banner | "Temperature took 6.8%, the inverter 3.6%, dust 0.7%. The cleaning calculator says: wait for rain — rain is modelled within a day, so washing now saves almost nothing. When it says CLEAN NOW, it means rupees." |
| 5 | 1:30–1:55 | `/outages/` page → run `publish_alerts` → **[AWS]** SNS console → email inbox | "The detector found outages humans miss — four dark days in February, 485 kilowatt-hours gone. One command publishes the alert to Amazon SNS — and the owner gets an email." |
| 6 | 1:55–2:25 | **[AWS]** EB console environment health green → `eb logs --stream` CloudWatch logs → application versions (S3) | "The whole app runs on AWS Elastic Beanstalk — single-instance free tier. Logs stream to CloudWatch, every deploy lands in S3, and `eb deploy` ships the repo in seconds." |
| 7 | 2:25–2:45 | API endpoint in browser (`/api/v1/loss/?site=bmt…`) + LightGBM result slide | "A JSON API serves the physics to anyone, and a walk-forward LightGBM catches what physics misses — 33% better than a weekly-naive baseline." |
| 8 | 2:45–2:55 | Impact strip (₹1,100 cr) + repo URL + AI disclosure | "Scale it to 3% of India's rooftop — ₹1,100 crore a year back on the table. Built with Django, pvlib, LightGBM and opencode. Code's public — try it on your own roof." |

## Recording checklist

- [ ] Deployed (`eb open` works in a signed-out/incognito window)
- [ ] Dashboard loaded with **real EB URL** in the address bar
- [ ] AWS console visible: EB environment + CloudWatch + SNS topic
- [ ] `publish_alerts` email lands in inbox during the take (or pre-trigger one)
- [ ] pytest run shown green (38 passed)
- [ ] Under 3:00 · unlisted/public YouTube · link opens signed-out
