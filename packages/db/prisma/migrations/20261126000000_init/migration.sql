-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "DocType" AS ENUM ('invoice', 'lease', 'market_report');

-- CreateEnum
CREATE TYPE "RunStatus" AS ENUM ('queued', 'extracting', 'extracted', 'failed', 'superseded');

-- CreateEnum
CREATE TYPE "ReviewState" AS ENUM ('pending', 'approved', 'corrected', 'carried_over');

-- CreateEnum
CREATE TYPE "ReviewAction" AS ENUM ('approve', 'correct');

-- CreateTable
CREATE TABLE "documents" (
    "id" TEXT NOT NULL,
    "type" "DocType" NOT NULL,
    "title" TEXT NOT NULL,
    "current_version" INTEGER NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "documents_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "document_versions" (
    "id" TEXT NOT NULL,
    "document_id" TEXT NOT NULL,
    "version_no" INTEGER NOT NULL,
    "file_name" TEXT,
    "file_bytes" BYTEA NOT NULL,
    "file_sha256" TEXT NOT NULL,
    "parsed_text" TEXT,
    "text_sha256" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "document_versions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "extraction_runs" (
    "id" TEXT NOT NULL,
    "version_id" TEXT NOT NULL,
    "status" "RunStatus" NOT NULL DEFAULT 'queued',
    "attempt" INTEGER NOT NULL DEFAULT 1,
    "recoveries" INTEGER NOT NULL DEFAULT 0,
    "lease_until" TIMESTAMPTZ(3),
    "worker_id" TEXT,
    "error" TEXT,
    "provider" TEXT,
    "model" TEXT,
    "prompt" TEXT,
    "raw_response" TEXT,
    "started_at" TIMESTAMPTZ(3),
    "finished_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "extraction_runs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "extracted_values" (
    "id" TEXT NOT NULL,
    "version_id" TEXT NOT NULL,
    "run_id" TEXT NOT NULL,
    "field" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "value" JSONB,
    "raw_value" TEXT,
    "evidence_quote" TEXT,
    "evidence_start" INTEGER,
    "evidence_end" INTEGER,
    "gap_reason" TEXT,
    "gap_detail" TEXT,
    "review_state" "ReviewState" NOT NULL DEFAULT 'pending',
    "changed" BOOLEAN NOT NULL DEFAULT false,
    "previous_value_id" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "extracted_values_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "reviews" (
    "id" TEXT NOT NULL,
    "value_id" TEXT NOT NULL,
    "action" "ReviewAction" NOT NULL,
    "value" TEXT,
    "note" TEXT,
    "carried_from_review_id" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "reviews_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "document_versions_document_id_version_no_key" ON "document_versions"("document_id", "version_no");

-- CreateIndex
CREATE INDEX "extraction_runs_status_lease_until_idx" ON "extraction_runs"("status", "lease_until");

-- CreateIndex
CREATE INDEX "extraction_runs_version_id_created_at_idx" ON "extraction_runs"("version_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "extracted_values_version_id_field_key" ON "extracted_values"("version_id", "field");

-- CreateIndex
CREATE INDEX "reviews_value_id_created_at_idx" ON "reviews"("value_id", "created_at");

-- AddForeignKey
ALTER TABLE "document_versions" ADD CONSTRAINT "document_versions_document_id_fkey" FOREIGN KEY ("document_id") REFERENCES "documents"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "extraction_runs" ADD CONSTRAINT "extraction_runs_version_id_fkey" FOREIGN KEY ("version_id") REFERENCES "document_versions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "extracted_values" ADD CONSTRAINT "extracted_values_version_id_fkey" FOREIGN KEY ("version_id") REFERENCES "document_versions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "extracted_values" ADD CONSTRAINT "extracted_values_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "extraction_runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "extracted_values" ADD CONSTRAINT "extracted_values_previous_value_id_fkey" FOREIGN KEY ("previous_value_id") REFERENCES "extracted_values"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reviews" ADD CONSTRAINT "reviews_value_id_fkey" FOREIGN KEY ("value_id") REFERENCES "extracted_values"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- At most one in-flight (queued/extracting) run per version: a backstop for the API's own locking.
CREATE UNIQUE INDEX "extraction_runs_one_active_per_version"
  ON "extraction_runs"("version_id") WHERE "status" IN ('queued', 'extracting');
