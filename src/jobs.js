// Очередь заданий копирования/обновления с логом и прогрессом для интерфейса.
import crypto from 'node:crypto';

const MAX_LOG_LINES = 4000;

export class Job {
  constructor({ projectId, projectName, teamId, bucket, mode }) {
    this.id = crypto.randomBytes(6).toString('hex');
    this.projectId = projectId;
    this.projectName = projectName;
    this.teamId = teamId;
    this.bucket = bucket;
    this.mode = mode; // 'copy' — создать копию, 'update' — обновить существующую
    this.status = 'queued'; // queued | running | done | error | canceled
    this.stage = 'В очереди';
    this.progress = null; // { done, total, bytes, totalBytes } на этапе выгрузки
    this.lines = [];
    this.dropped = 0;
    this.createdAt = Date.now();
    this.startedAt = null;
    this.finishedAt = null;
    this.error = null;
    this.result = null;
    this.warnings = [];
    this.abort = new AbortController();
  }

  log(msg, level = 'info') {
    for (const line of String(msg).split(/\r?\n/)) {
      this.lines.push({ t: Date.now(), level, msg: line });
    }
    if (level === 'warn') this.warnings.push(String(msg));
    if (this.lines.length > MAX_LOG_LINES) {
      const cut = this.lines.length - MAX_LOG_LINES;
      this.lines.splice(0, cut);
      this.dropped += cut;
    }
  }

  setStage(stage) {
    this.stage = stage;
    this.log(`— ${stage}`, 'stage');
  }

  summary() {
    return {
      id: this.id,
      projectId: this.projectId,
      projectName: this.projectName,
      bucket: this.bucket,
      mode: this.mode,
      status: this.status,
      stage: this.stage,
      progress: this.progress,
      createdAt: this.createdAt,
      startedAt: this.startedAt,
      finishedAt: this.finishedAt,
      error: this.error,
      result: this.result,
      warnings: this.warnings.slice(-10),
      logSize: this.dropped + this.lines.length,
    };
  }

  /** Строки лога начиная с абсолютного номера `from`. */
  logFrom(from = 0) {
    const start = Math.max(0, from - this.dropped);
    return { from: this.dropped + start, lines: this.lines.slice(start), next: this.dropped + this.lines.length };
  }
}

export class JobManager {
  constructor({ run, concurrency = () => 1, onFinished } = {}) {
    this.run = run;
    this.concurrency = concurrency;
    this.onFinished = onFinished;
    this.jobs = [];
    this.active = 0;
  }

  /** Добавляет задание; повторный запрос для того же проекта, пока задание не завершено, возвращает существующее. */
  enqueue(spec) {
    const pending = this.jobs.find((j) => j.projectId === spec.projectId && (j.status === 'queued' || j.status === 'running'));
    if (pending) return pending;
    const job = new Job(spec);
    this.jobs.push(job);
    // Храним историю последних 200 заданий.
    const finished = this.jobs.filter((j) => j.finishedAt);
    if (finished.length > 200) {
      const drop = new Set(finished.slice(0, finished.length - 200));
      this.jobs = this.jobs.filter((j) => !drop.has(j));
    }
    this.#pump();
    return job;
  }

  get(id) {
    return this.jobs.find((j) => j.id === id) || null;
  }

  list() {
    return this.jobs.map((j) => j.summary());
  }

  latestFor(projectId) {
    for (let i = this.jobs.length - 1; i >= 0; i--) if (this.jobs[i].projectId === projectId) return this.jobs[i];
    return null;
  }

  cancel(id) {
    const job = this.get(id);
    if (!job) return null;
    if (job.status === 'queued') {
      job.status = 'canceled';
      job.stage = 'Отменено';
      job.finishedAt = Date.now();
    } else if (job.status === 'running') {
      job.log('Отмена…', 'warn');
      job.abort.abort();
    }
    return job;
  }

  clearFinished() {
    this.jobs = this.jobs.filter((j) => !j.finishedAt);
  }

  get busy() {
    return this.jobs.some((j) => j.status === 'queued' || j.status === 'running');
  }

  #pump() {
    while (this.active < Math.max(1, this.concurrency())) {
      const job = this.jobs.find((j) => j.status === 'queued');
      if (!job) return;
      this.active++;
      job.status = 'running';
      job.startedAt = Date.now();
      Promise.resolve()
        .then(() => this.run(job))
        .then(
          () => {
            job.status = 'done';
            job.stage = 'Готово';
          },
          (err) => {
            job.status = err?.cancelled || job.abort.signal.aborted ? 'canceled' : 'error';
            job.stage = job.status === 'canceled' ? 'Отменено' : 'Ошибка';
            job.error = job.status === 'canceled' ? null : err?.message || String(err);
            if (job.error) job.log(job.error, 'error');
          },
        )
        .finally(async () => {
          job.finishedAt = Date.now();
          job.progress = job.status === 'done' ? job.progress : null;
          this.active--;
          try {
            await this.onFinished?.(job);
          } catch {
            /* не мешаем очереди */
          }
          this.#pump();
        });
    }
  }
}
