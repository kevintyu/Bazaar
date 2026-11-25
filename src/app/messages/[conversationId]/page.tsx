import { ConversationDetail } from '@/components/transactions/conversation-pages';
export default async function Page({ params }: { params: Promise<{ conversationId: string }> }) {
 const { conversationId } = await params;
 return <ConversationDetail key={conversationId} id={conversationId} />;
}
