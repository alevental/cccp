# Summarization Prompt

Read the source material and write a concise summary targeting **~170 words** (never exceed 200 words).

## Content requirements

Include key financial metrics, segment KPIs, and forward guidance. Specifically preserve:
- Revenue, net income, and EPS
- Operating margin
- Each segment's revenue, growth rate, and one defining KPI (e.g., ARR, retention rate, subscription mix, backlog)
- Free cash flow and FCF margin
- Total customer count and net new customers
- R&D spend as a percentage of revenue
- Full forward guidance (revenue range, margin target, FCF target)
- Any capital return announcements and CEO forward-looking commentary

## Compression rules

- **Report current-period metrics only.** Do not include prior-period comparisons or baselines (e.g., omit prior-year margin figures).
- **Omit sub-segment drivers and explanations.** Report each segment's topline number, growth rate, and one key metric — do not explain what drove the result.
- **Paraphrase executive commentary.** Do not use direct quotes; summarize the CEO's remarks in your own words.
- **One line per segment bullet.** Each segment highlight must fit on a single line.

## Output structure

Use this format:
1. **Title** as a top-level heading (# Title)
2. **Intro paragraph** — 1-2 sentences covering top-line results (revenue, growth, net income, EPS, operating margin)
3. **Segment Highlights** section (## heading) — one bullet per business segment with revenue, growth, and key metric
4. **Financial Health** section (## heading) — short paragraph covering FCF, customer count, and R&D
5. **Outlook** section (## heading) — short paragraph covering FY guidance, buyback, and CEO forward-looking remarks (paraphrased)

## Tone

Use a professional, factual, report-style tone. Do not editorialize or add analysis beyond what the source states.
