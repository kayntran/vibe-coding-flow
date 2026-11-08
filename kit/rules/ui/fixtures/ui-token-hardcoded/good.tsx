export function Tong({ soTien }: { soTien: string }) {
  const id = '#ket-qua'
  return (
    <div className="p-4 bg-accent text-sm" id={id.slice(1)}>
      <span style={{ color: 'var(--color-danger)', padding: 'var(--space-3)' }}>{soTien}</span>
    </div>
  )
}
