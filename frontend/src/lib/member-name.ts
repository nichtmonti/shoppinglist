import { t } from './i18n';

/**
 * How a member's nickname is shown. An account's nickname may be empty (an
 * OIDC provider that sent no name claim), and the server holds no UI text, so
 * the placeholder is the client's, in the active locale.
 */
export function memberName(nickname: string | null | undefined): string {
	return nickname || t('member_unnamed');
}
