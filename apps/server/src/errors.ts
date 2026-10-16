import type { FastifyReply, FastifyRequest } from "fastify";
import { ZodError } from "zod";

export class ApiError extends Error {
  constructor(
    public readonly statusCode: number,
    public readonly code: string,
    public readonly messageAr: string,
    public readonly details?: unknown,
  ) {
    super(code);
  }
}

const PG_CODES: Record<string, { status: number; code: string; messageAr: string }> = {
  "23505": { status: 409, code: "VERSION_CONFLICT", messageAr: "توجد بيانات مسجلة بالقيمة نفسها" },
  "23503": { status: 409, code: "REFERENCE_CONFLICT", messageAr: "العملية مرتبطة ببيانات أخرى" },
  "23514": { status: 422, code: "BUSINESS_RULE", messageAr: "العملية تخالف قاعدة عمل" },
  "40001": { status: 409, code: "RETRY_TRANSACTION", messageAr: "تعارضت العملية مع عملية أخرى؛ أعد المحاولة بالمفتاح نفسه" },
  "40P01": { status: 409, code: "RETRY_TRANSACTION", messageAr: "تعارض قفل قاعدة البيانات؛ أعد المحاولة بالمفتاح نفسه" },
};

function postgresCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error && typeof error.code === "string" ? error.code : undefined;
}

export function errorHandler(error: unknown, request: FastifyRequest, reply: FastifyReply): void {
  if (error instanceof ApiError) {
    void reply.status(error.statusCode).send({ code: error.code, messageAr: error.messageAr, details: error.details, requestId: request.id });
    return;
  }
  if (error instanceof ZodError) {
    void reply.status(400).send({
      code: "VALIDATION",
      messageAr: "البيانات المرسلة غير صالحة",
      details: error.issues.map((issue) => ({ path: issue.path.join("."), message: issue.message })),
      requestId: request.id,
    });
    return;
  }
  const pg = PG_CODES[postgresCode(error) ?? ""];
  if (pg) {
    void reply.status(pg.status).send({ code: pg.code, messageAr: pg.messageAr, requestId: request.id });
    return;
  }
  request.log.error({ err: error }, "unhandled request error");
  void reply.status(500).send({ code: "INTERNAL", messageAr: "حدث خطأ داخلي غير متوقع", requestId: request.id });
}
