import { z } from 'zod';
import { stillDeletable } from '../notifier/cleanup.js';
import { notifyAdmins, userLabel } from './context.js';
import { defineTool, ToolError } from './tool.js';

const kind = (t: 'movie' | 'tv') => (t === 'movie' ? 'Film' : 'Serie');

/** User side: the answer to "may this be deleted?". */
export const answerCleanup = defineTool({
  name: 'answer_cleanup',
  description:
    'Hält fest, ob der Nutzer zustimmt, dass ein von ihm angefragter und komplett gesehener Titel vom Server gelöscht wird (Angebot steht unter "Offene Löschfragen"). Nur aufrufen, wenn er sich klar geäußert hat. Bei Ja geht die Freigabe an den Admin, gelöscht wird nie direkt.',
  schema: z.object({
    offerId: z.number().int().describe('Nummer aus "Offene Löschfragen"'),
    agree: z.boolean().describe('true = er ist mit dem Löschen einverstanden, false = Titel soll bleiben'),
  }),
  async run({ offerId, agree }, ctx) {
    const offer = ctx.repo.getCleanupOffer(offerId);
    if (!offer || offer.user_id !== ctx.user.id) throw new ToolError('Diese Löschfrage gibt es nicht.');
    if (offer.status !== 'asked') throw new ToolError('Diese Löschfrage ist schon beantwortet.');

    if (!agree) {
      ctx.repo.updateCleanupOffer(offer.id, { status: 'declined' });
      ctx.repo.addFact(ctx.user.id, `Möchte nicht, dass "${offer.title}" gelöscht wird (nicht erneut danach fragen)`, 'agent');
      ctx.repo.logAction(ctx.user.id, null, 'cleanup_declined', { offerId: offer.id, title: offer.title });
      return { ok: true, note: 'Alles klar, der Titel bleibt. Kurz und freundlich bestätigen, ohne nachzuhaken.' };
    }

    const ticket = ctx.repo.createTicket({
      user_id: ctx.user.id,
      title: `Löschung freigeben: ${offer.title}`.slice(0, 80),
      description: `${userLabel(ctx.user)} hat ${kind(offer.media_type)} "${offer.title}" angefragt, komplett gesehen und stimmt dem Löschen zu.`,
      category: 'other',
      severity: 'low',
    });
    ctx.repo.updateTicket(ticket.id, { status: 'escalated' });
    ctx.repo.updateCleanupOffer(offer.id, { status: 'agreed', ticket_id: ticket.id });
    ctx.repo.logAction(ctx.user.id, ticket.id, 'cleanup_agreed', { offerId: offer.id, title: offer.title });
    await notifyAdmins(
      ctx,
      `🧹 *Löschfreigabe* (Ticket #${ticket.id}, Angebot ${offer.id}): ${userLabel(ctx.user)} hat ${kind(offer.media_type)} *${offer.title}* angefragt, komplett gesehen und stimmt dem Löschen zu. Laut System hat es sonst niemand offen.\n\nAntworte "löschen" (oder "behalten"), dann setze ich es um.`,
    );
    return { ok: true, note: `Die Löschung wartet jetzt auf die Freigabe von ${ctx.config.ADMIN_NAME}. Sag das dem Nutzer, versprich nichts zum Zeitpunkt.` };
  },
});

/** Admin side: overview. */
export const listCleanupOffers = defineTool({
  name: 'list_cleanup_offers',
  description: 'Löschangebote: welche Nutzer wurden gefragt und welche warten auf deine Freigabe (agreed).',
  schema: z.object({ onlyAgreed: z.boolean().default(true) }),
  async run({ onlyAgreed }, ctx) {
    const list = ctx.repo.listCleanupOffers(onlyAgreed ? ['agreed'] : ['asked', 'agreed', 'declined', 'deleted', 'rejected']);
    return list.map((o) => {
      const u = ctx.repo.getUser(o.user_id);
      return { offerId: o.id, title: o.title, type: kind(o.media_type), status: o.status, user: u ? userLabel(u) : '?', ticketId: o.ticket_id, asked: o.asked_at };
    });
  },
});

/** Admin side: final decision. */
export const decideCleanup = defineTool({
  name: 'decide_cleanup',
  description:
    'Gibt eine Löschung frei oder lehnt sie ab. delete entfernt den Titel samt Dateien aus Radarr/Sonarr (und Jellyseerr). Nur nach ausdrücklichem Ja des Admins und nur für Angebote mit Status agreed. Vor dem Löschen wird noch einmal geprüft, ob jemand den Titel inzwischen angefangen hat.',
  schema: z.object({
    offerId: z.number().int(),
    action: z.enum(['delete', 'keep']),
    force: z.boolean().default(false).describe('Auch löschen, wenn jemand anderes den Titel noch offen hat'),
  }),
  async run({ offerId, action, force }, ctx) {
    if (!ctx.isAdmin) throw new ToolError('Nur der Admin darf Löschungen freigeben.');
    const offer = ctx.repo.getCleanupOffer(offerId);
    if (!offer) throw new ToolError('Angebot nicht gefunden. Nutze list_cleanup_offers.');
    if (offer.status !== 'agreed') throw new ToolError(`Angebot hat Status "${offer.status}": nur zugestimmte Angebote (agreed) können entschieden werden.`);

    const close = (resolution: string) => {
      if (offer.ticket_id) ctx.repo.updateTicket(offer.ticket_id, { status: 'resolved', resolution });
    };

    if (action === 'keep') {
      ctx.repo.updateCleanupOffer(offer.id, { status: 'rejected' });
      close('Löschung nicht freigegeben, Titel bleibt');
      return { ok: true, note: 'Titel bleibt. Der Nutzer wird nicht extra informiert.' };
    }

    const { sonarr, radarr, seerr } = ctx.services;
    if (!force && !(await stillDeletable(ctx, offer))) {
      throw new ToolError('Jemand anderes hat den Titel noch offen (angefangen oder angefragt). Nicht gelöscht. Mit force=true trotzdem löschen oder mit keep behalten.');
    }
    if (offer.media_type === 'movie') {
      if (!radarr) throw new ToolError('Radarr ist nicht konfiguriert, ich kann den Film nicht löschen.');
      const [m] = await radarr.find({ tmdbId: offer.tmdb_id });
      if (!m) throw new ToolError('Der Film ist in Radarr nicht (mehr) vorhanden.');
      await radarr.deleteMovie(m.radarrId);
    } else {
      if (!sonarr) throw new ToolError('Sonarr ist nicht konfiguriert, ich kann die Serie nicht löschen.');
      const [s] = await sonarr.find({ tmdbId: offer.tmdb_id });
      if (!s) throw new ToolError('Die Serie ist in Sonarr nicht (mehr) vorhanden.');
      await sonarr.deleteSeries(s.sonarrId);
    }
    // Jellyseerr keeps showing the title as available otherwise, and nobody could request it again.
    let seerrNote: string | undefined;
    if (seerr) {
      try {
        const id = (await seerr.details(offer.media_type, offer.tmdb_id)).mediaInfo?.id;
        if (id) await seerr.removeMedia(id);
      } catch (err) {
        seerrNote = `Jellyseerr-Eintrag konnte nicht entfernt werden: ${(err as Error).message}`;
      }
    }
    ctx.repo.updateCleanupOffer(offer.id, { status: 'deleted' });
    close('Titel auf Wunsch des Nutzers gelöscht');
    ctx.repo.logAction(offer.user_id, offer.ticket_id, 'cleanup_deleted', { offerId: offer.id, title: offer.title });
    ctx.dispatchEvent(
      offer.user_id,
      `${kind(offer.media_type)} "${offer.title}" wurde wie besprochen vom Server gelöscht. Sag dem Nutzer kurz Bescheid und danke ihm. Wenn er es später nochmal sehen will, kann er es jederzeit neu anfragen.`,
    );
    return { ok: true, deleted: offer.title, note: seerrNote };
  },
});
