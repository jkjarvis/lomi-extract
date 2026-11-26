-- A reviewer can confirm that a gap is genuinely absent from the document (gaps only; enforced by the API).
ALTER TYPE "ReviewAction" ADD VALUE 'confirm_missing';
