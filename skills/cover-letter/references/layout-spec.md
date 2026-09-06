# Modern application layout

Use a restrained single-column system that feels contemporary, readable, and
appropriate for recruiting. Visual polish should come from typography,
alignment, and spacing rather than decoration.

## Page and type tokens

- Page: US Letter, portrait
- Margins: 1 inch on every side
- Base preset: `standard_business_brief`
- Body font: Calibri, 11.25 pt, `#202833`
- Body alignment: left
- Body spacing: 0 pt before, 8 pt after, 1.15 line spacing
- Date: 9.5 pt, `#5A6772`
- Role/company line: 12.5 pt, bold, `#1B6B78`
- Job identifier: 9.5 pt, `#5A6772`, only when useful
- Salutation and signature: 11.25 pt; signature bold

These are named `modern_application` overrides to the base preset. Apply them
consistently rather than introducing one-off formatting.

## First-page composition

Build the page in this order:

1. Date
2. Role and company line, with job identifier on a quiet secondary line
3. 14-18 pt before the salutation
4. Three or four short body paragraphs
5. Closing and candidate name

For application-portal uploads, omit the sender name and contact-information
block at the top because the form and resume already provide those details.
Keep the candidate's name in the signature. Add a sender header only when the
user explicitly requests it or the letter will be sent independently outside
an application portal.

Do not add the candidate's street address, the company's mailing address, a
`Re:` line, a decorative rule, a centered title stack, a photo, or icons. Do not
use a table for header layout.

## Balance and QA

- Keep all content on one page without shrinking body text below 11 pt.
- Prefer editing prose over reducing margins or type size.
- Begin the date and role block near the top margin so the body starts in the
  upper third of the page.
- Avoid orphaned closing lines and excessive blank space between components.
- Render the DOCX/PDF and inspect the complete page at full size.
- Confirm the PDF has one page, searchable text, no Unicode dash characters,
  and a stable recruiter-friendly filename.
