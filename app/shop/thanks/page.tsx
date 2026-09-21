export default async function ThanksPage({
  searchParams,
}: {
  searchParams: Promise<{ order?: string }>;
}) {
  const { order } = await searchParams;

  return (
    <main className="mx-auto w-full max-w-3xl flex-1 px-6 py-16">
      <h1 className="text-3xl text-zinc-50">ご注文を受け付けました</h1>
      <p className="mt-4 text-sm text-zinc-400">
        注文ID: {order ?? "unknown"}。この注文は販売テストの実測として記録されます。
      </p>
    </main>
  );
}
