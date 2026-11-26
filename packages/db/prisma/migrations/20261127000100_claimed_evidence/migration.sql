-- For hallucination gaps (evidence_not_in_text / value_not_in_evidence): the quote the model claimed, kept for the
-- reviewer's context only. It is never used as evidence and the value stays NULL.
ALTER TABLE "extracted_values" ADD COLUMN "claimed_evidence" TEXT;
