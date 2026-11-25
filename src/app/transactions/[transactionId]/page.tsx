import { TransactionDetail } from '@/components/transactions/transaction-pages';
export default async function Page({ params }: { params: Promise<{ transactionId: string }> }) {
 const { transactionId } = await params;
 return <TransactionDetail key={transactionId} id={transactionId} />;
}
