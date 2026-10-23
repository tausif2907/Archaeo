/*
  Warnings:

  - Added the required column `qualifiedName` to the `Symbol` table without a default value. This is not possible if the table is not empty.

*/
-- AlterTable
ALTER TABLE "Symbol" ADD COLUMN     "qualifiedName" TEXT NOT NULL;
