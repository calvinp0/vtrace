def my_function(name: str) -> str:
    return name


async def fetch_user(user_id: str) -> str:
    return user_id


class SessionManager:
    def create_session(self, user_id: str) -> str:
        return user_id

    async def refresh_session(self) -> None:
        return None


def outer() -> int:
    def nested() -> int:
        return 1

    return nested()
