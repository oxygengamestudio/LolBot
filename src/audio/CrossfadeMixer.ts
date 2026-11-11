import { Readable } from 'stream';

/** PCM signé 16 bits, 48 kHz, stéréo : le format que FFmpeg fournit au pipeline. */
export const PCM_BYTES_PER_SECOND = 48_000 * 2 * 2;
const BYTES_PER_FRAME = 4;
/** Taille des blocs remis au lecteur : 20 ms, soit une trame Opus. */
const BLOCK_BYTES = PCM_BYTES_PER_SECOND / 50;
/** En dessous de cette durée restante, un fondu n'est plus audible : on enchaîne sans mixer. */
const MIN_FADE_BYTES = PCM_BYTES_PER_SECOND / 4;

function alignDown(bytes: number): number {
    return bytes - (bytes % BYTES_PER_FRAME);
}

/**
 * Tampon d'avance sur une source PCM. Il lit la source plus vite qu'elle n'est
 * jouée, jusqu'à `highWaterBytes`, ce qui permet de savoir que la piste se
 * termine avant que sa fin ne soit audible.
 */
export class PcmDeck {
    private chunks: Buffer[] = [];
    private bufferedBytes = 0;
    private sourceEnded = false;
    private paused = false;
    private destroyed = false;

    private readonly onData = (chunk: Buffer): void => {
        this.chunks.push(chunk);
        this.bufferedBytes += chunk.length;
        if (this.bufferedBytes >= this.highWaterBytes && !this.paused) {
            this.paused = true;
            this.source.pause();
        }
        this.onChange();
    };

    private readonly onEnd = (): void => {
        if (this.sourceEnded) return;
        this.sourceEnded = true;
        this.onChange();
    };

    constructor(
        private readonly source: Readable,
        private highWaterBytes: number,
        private onChange: () => void = () => undefined
    ) {
        source.on('data', this.onData);
        source.once('end', this.onEnd);
        source.once('close', this.onEnd);
        source.once('error', this.onEnd);
        if (source.readableEnded || source.destroyed) {
            this.sourceEnded = true;
        }
    }

    /** Octets disponibles, arrondis à un échantillon stéréo complet. */
    get length(): number {
        return alignDown(this.bufferedBytes);
    }

    /** La source n'enverra plus rien : `length` est exactement ce qu'il reste à jouer. */
    get ended(): boolean {
        return this.sourceEnded;
    }

    setListener(onChange: () => void): void {
        this.onChange = onChange;
    }

    /** Attend les premières données. `false` si la source se ferme vide ou reste muette. */
    waitForData(timeoutMs: number): Promise<boolean> {
        if (this.length > 0 || this.sourceEnded) {
            return Promise.resolve(this.length > 0);
        }
        return new Promise((resolve) => {
            const previous = this.onChange;
            const settle = (): void => {
                clearTimeout(timer);
                this.onChange = previous;
                resolve(this.length > 0);
            };
            const timer = setTimeout(settle, timeoutMs);
            timer.unref?.();
            this.onChange = () => {
                if (this.length > 0 || this.sourceEnded) settle();
            };
        });
    }

    setHighWater(bytes: number): void {
        this.highWaterBytes = bytes;
        this.resumeIfNeeded();
    }

    /** Retire jusqu'à `maxBytes` du tampon, toujours un nombre entier d'échantillons. */
    read(maxBytes: number): Buffer {
        const wanted = Math.min(alignDown(maxBytes), this.length);
        if (wanted <= 0) {
            return Buffer.alloc(0);
        }

        const first = this.chunks[0]!;
        let out: Buffer;
        if (first.length === wanted) {
            out = first;
            this.chunks.shift();
        } else if (first.length > wanted) {
            out = first.subarray(0, wanted);
            this.chunks[0] = first.subarray(wanted);
        } else {
            out = Buffer.allocUnsafe(wanted);
            let offset = 0;
            while (offset < wanted) {
                const chunk = this.chunks[0]!;
                const take = Math.min(chunk.length, wanted - offset);
                chunk.copy(out, offset, 0, take);
                offset += take;
                if (take === chunk.length) {
                    this.chunks.shift();
                } else {
                    this.chunks[0] = chunk.subarray(take);
                }
            }
        }

        this.bufferedBytes -= wanted;
        this.resumeIfNeeded();
        return out;
    }

    destroy(): void {
        if (this.destroyed) return;
        this.destroyed = true;
        this.sourceEnded = true;
        this.source.removeListener('data', this.onData);
        this.chunks = [];
        this.bufferedBytes = 0;
        this.onChange = () => undefined;
        // La fermeture de la source déclenche le nettoyage de son propriétaire (FFmpeg, fichiers temporaires).
        this.source.destroy();
    }

    private resumeIfNeeded(): void {
        if (this.paused && !this.destroyed && this.bufferedBytes < this.highWaterBytes) {
            this.paused = false;
            this.source.resume();
        }
    }
}

interface PendingNext {
    deck: PcmDeck;
    fadeBytes: number;
    accept: () => boolean;
}

/**
 * Flux PCM d'une guilde. Il joue une source et, si une source suivante lui est
 * attachée avant la fin, mixe les deux pendant le fondu puis continue sur la
 * suivante sans que le lecteur Discord ne s'arrête. Sans source suivante, le
 * flux se termine normalement et la transition classique prend le relais.
 *
 * Émet `tail` chaque fois que la fin de la source courante devient connue :
 * c'est le moment de préparer la piste suivante.
 */
export class CrossfadeMixer extends Readable {
    private current: PcmDeck;
    private next: PendingNext | null = null;
    private fade: { total: number; done: number; outgoing: PcmDeck } | null = null;
    private tailAnnounced = false;
    private pumping = false;
    private wantsData = false;
    private finished = false;
    private readonly lookaheadBytes: number;

    constructor(source: Readable, lookaheadSeconds: number) {
        super({ highWaterMark: BLOCK_BYTES * 5 });
        this.lookaheadBytes = Math.max(BLOCK_BYTES * 10, Math.floor(lookaheadSeconds * PCM_BYTES_PER_SECOND));
        this.current = new PcmDeck(source, this.lookaheadBytes, () => this.pump());
    }

    /** La fin de la piste courante est connue et aucune suite n'est encore attachée. */
    get awaitingNext(): boolean {
        return !this.finished && !this.destroyed && this.current.ended && !this.next && !this.fade;
    }

    get hasPendingNext(): boolean {
        return this.next !== null;
    }

    /**
     * Attache le tampon de la piste suivante, créé dès le lancement de sa source. `accept` est appelé à l'instant où
     * le fondu commence : s'il renvoie `false`, la source est abandonnée et la
     * piste courante se termine seule.
     */
    attachNext(deck: PcmDeck, fadeSeconds: number, accept: () => boolean): boolean {
        if (this.finished || this.destroyed || this.next || this.fade) {
            deck.destroy();
            return false;
        }
        deck.setListener(() => this.pump());
        deck.setHighWater(this.lookaheadBytes);
        this.next = {
            deck,
            fadeBytes: alignDown(Math.max(0, Math.floor(fadeSeconds * PCM_BYTES_PER_SECOND))),
            accept,
        };
        this.pump();
        return true;
    }

    /** Abandonne une suite attachée dont le fondu n'a pas commencé. */
    detachNext(): void {
        if (!this.next) return;
        this.next.deck.destroy();
        this.next = null;
    }

    override _read(): void {
        this.wantsData = true;
        this.pump();
    }

    override _destroy(error: Error | null, callback: (error?: Error | null) => void): void {
        this.finished = true;
        this.current.destroy();
        this.fade?.outgoing.destroy();
        this.next?.deck.destroy();
        this.next = null;
        this.fade = null;
        callback(error);
    }

    private pump(): void {
        if (this.pumping || this.finished || this.destroyed) return;
        this.pumping = true;
        try {
            this.announceTail();
            while (this.wantsData && !this.finished) {
                const block = this.nextBlock();
                if (block === null) {
                    this.finished = true;
                    this.push(null);
                    return;
                }
                if (block.length === 0) {
                    return;
                }
                this.wantsData = this.push(block);
                this.announceTail();
            }
        } finally {
            this.pumping = false;
        }
    }

    private announceTail(): void {
        if (this.tailAnnounced || !this.current.ended || this.fade) return;
        this.tailAnnounced = true;
        this.emit('tail');
    }

    /** `null` : fin du flux. Tampon vide : rien de disponible pour l'instant. */
    private nextBlock(): Buffer | null {
        if (this.fade) {
            return this.mixBlock();
        }

        const current = this.current;
        const next = this.next;
        if (next && current.ended && current.length <= next.fadeBytes) {
            if (!next.accept()) {
                this.detachNext();
                return this.nextBlock();
            }
            this.next = null;
            const outgoing = current;
            this.current = next.deck;
            this.tailAnnounced = false;
            if (outgoing.length < MIN_FADE_BYTES) {
                // Trop peu de matière pour un fondu : on enchaîne simplement.
                const rest = outgoing.read(outgoing.length);
                outgoing.destroy();
                return rest.length > 0 ? rest : this.nextBlock();
            }
            this.fade = { total: outgoing.length, done: 0, outgoing };
            return this.mixBlock();
        }

        if (current.length > 0) {
            // Ne jamais entamer la zone réservée au fondu de la suite attachée.
            const limit = next && current.ended ? current.length - next.fadeBytes : current.length;
            return current.read(Math.min(BLOCK_BYTES, limit));
        }
        return current.ended ? null : Buffer.alloc(0);
    }

    /** Mixe un bloc : la piste sortante descend, la nouvelle monte (courbe à puissance constante). */
    private mixBlock(): Buffer | null {
        const fade = this.fade!;
        const out = fade.outgoing.read(Math.min(BLOCK_BYTES, fade.total - fade.done));
        if (out.length === 0) {
            fade.outgoing.destroy();
            this.fade = null;
            return this.nextBlock();
        }

        const incoming = this.current.read(out.length);
        const mixed = Buffer.allocUnsafe(out.length);
        for (let offset = 0; offset < out.length; offset += 2) {
            const progress = (fade.done + offset) / fade.total;
            const angle = progress * (Math.PI / 2);
            const incomingSample = offset < incoming.length ? incoming.readInt16LE(offset) : 0;
            const sample = Math.round(out.readInt16LE(offset) * Math.cos(angle) + incomingSample * Math.sin(angle));
            mixed.writeInt16LE(Math.max(-32768, Math.min(32767, sample)), offset);
        }
        fade.done += out.length;
        if (fade.done >= fade.total) {
            fade.outgoing.destroy();
            this.fade = null;
        }
        return mixed;
    }
}
