import './home.css'

// S-01: màn đầu, còn trống. Thay bằng màn thật khi app có SPEC.
export function HomeScreen() {
  return (
    <main data-s="S-01" className="home">
      <h1>{{APP_NAME}}</h1>
      <p>Chưa có màn nào — bảo AI làm màn đầu tiên.</p>
    </main>
  )
}
