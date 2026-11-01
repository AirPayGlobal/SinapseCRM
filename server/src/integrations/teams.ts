import { config } from '../config.js';
import { logIntegration } from './fabric.js';

/** Microsoft Teams notifications (escalation, breach and threshold) through an incoming webhook / workflow URL. */
export const teamsConfigured = () => Boolean(config.teamsWebhookUrl);

export async function postToTeams(title: string, text: string, link?: string) {
  const card = {
    type: 'message',
    attachments: [{
      contentType: 'application/vnd.microsoft.card.adaptive',
      content: {
        $schema: 'http://adaptivecards.io/schemas/adaptive-card.json', type: 'AdaptiveCard', version: '1.4',
        body: [{ type: 'TextBlock', size: 'Medium', weight: 'Bolder', text: title, wrap: true }, { type: 'TextBlock', text, wrap: true }],
        actions: link ? [{ type: 'Action.OpenUrl', title: 'Open in Sinapse CRM', url: link }] : [],
      },
    }],
  };
  const r = await fetch(config.teamsWebhookUrl, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(card) });
  if (!r.ok) throw new Error(`Teams webhook returned ${r.status}`);
  await logIntegration(null, { connector: 'teams', direction: 'outbound', operation: 'post', status: 'success', payload: { title } });
}
