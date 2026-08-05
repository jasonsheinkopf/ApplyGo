# ApplyGo Autofill (browser extension)

Fills a job application form from your ApplyGo profile, your job-tailored resume, and your saved
answers. **It never submits anything for you.**

## Why an extension and not the server

ApplyGo already runs a headless browser (Cloudflare Browser Rendering) to render resume PDFs, so
the obvious idea is to have the server fill out application forms too. That does not work reliably:

- Cloudflare's browsers run from datacenter IPs, which ATS bot detection flags.
- CAPTCHAs end the attempt with no way to continue.
- Workday and similar require an account and a logged-in session.
- There is no way for you to step in when something goes wrong mid-run.

Running in your own browser solves all four at once. You are already logged in where it matters,
the traffic looks exactly like you (because it is you), and when a CAPTCHA appears you solve it in
two seconds. It also reads the live DOM, so it works on job boards ApplyGo has never seen rather
than only the four ATS platforms it knows how to scan.

## Why it stops short of submitting

Submitting a job application cannot be undone. A mis-filled auto-submit is not recoverable, and
"probably right" is not a good enough standard for something an employer reads once and judges you
on. So the extension fills every field it can, outlines what it touched in blue and what it left
blank in amber, and hands the page back to you. Simplify behaves the same way.

## Install

1. Open `chrome://extensions`, enable **Developer mode**.
2. **Load unpacked**, select this `extension/` directory.
3. In ApplyGo, go to the **Devices** tab and create an enrollment code.
4. Click the extension icon, paste the code, confirm the ApplyGo URL, and press **Connect**.

The extension enrolls as its own device, so it appears in the Devices tab and is revoked there like
any other. No store listing and no Google review are involved, because this is loaded unpacked for
one person.

## Using it

On an application page, click the icon and press **Fill this form**. It will:

1. Read every labeled field on the page, collapsing radio groups into one question each.
2. Match the page URL against your ApplyGo jobs, so the tailored resume and cover letter for *that*
   job get used when one exists.
3. Fill what it can, attach the resume PDF, and drop the cover letter into a cover-letter textarea.
4. List anything it could not answer. Type an answer once and it is saved to your answer bank, so
   the next company that asks the same question is already handled.

Then review, solve a CAPTCHA if there is one, and submit it yourself. Afterwards, **Mark as applied
in ApplyGo** moves the job to the Applied tab.

## What it will not guess

Work authorization, sponsorship, citizenship, veteran status, disability, gender, race, criminal
history, salary expectations, notice period, start date, relocation, and security clearance never
reach the model. These are legally or personally consequential and a confident guess is worse than
no answer. Either your answer bank already has it or you are asked. That rule lives in
`NEVER_INFER` in `cloudflare/src/index.ts`.

## Supported sites

Greenhouse, Lever, Ashby, and SmartRecruiters are wired up in `manifest.json`. Adding another is a
matter of adding its URL pattern to both `host_permissions` and `content_scripts.matches`; the
form-reading code itself is not vendor-specific.
