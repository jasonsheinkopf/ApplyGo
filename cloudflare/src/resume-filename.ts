/**
 * The filename the extension uploads the tailored resume as. Kept in its own leaf module (no local
 * imports, unlike index.ts) so it can be unit tested directly under Node's test runner without
 * pulling in index.ts's full dependency graph -- see resume-filename.test.ts.
 */

/** One path segment of a filename -- ASCII letters/digits/underscores only, nothing an OS or an
 * employer's upload handler could choke on, and never a truncated fragment of a longer accented
 * name (José normalizes to Jose, not a silently dropped character). */
export function sanitizeForFilename(text: string): string {
  return text
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-zA-Z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 60);
}

/**
 * The filename the extension uploads the resume as -- `FirstName_LastName_Company.pdf`, never the
 * resume row's internal id or a generic "resume.pdf" that tells the employer's ATS nothing about
 * who this is or which application it belongs to. Falls back to `FirstName_LastName_Resume.pdf`
 * when there's no job/company to attach it to.
 */
export function resumeFilenameFor(candidateName: string, company: string): string {
  const [first, ...rest] = String(candidateName ?? "").trim().split(/\s+/).filter(Boolean);
  const firstPart = sanitizeForFilename(first || "") || "Candidate";
  const lastPart = sanitizeForFilename(rest.join(" "));
  const namePart = lastPart ? `${firstPart}_${lastPart}` : firstPart;
  const companyPart = sanitizeForFilename(company || "");
  return `${namePart}_${companyPart || "Resume"}.pdf`;
}
