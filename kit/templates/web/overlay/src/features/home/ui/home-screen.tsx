// S-01: màn đầu, còn trống. Thay bằng màn thật khi app có SPEC.
export function HomeScreen() {
  return (
    <main data-s="S-01" className="mx-auto flex min-h-svh max-w-md flex-col items-center justify-center gap-2 p-6 text-center">
      <h1 className="text-2xl font-semibold">{{APP_NAME}}</h1>
      <p className="text-balance text-muted-foreground">Chưa có màn nào — bảo AI làm màn đầu tiên.</p>
    </main>
  )
}
