from calc import add, average
from greet import greet


def test_greet():
    assert greet("World") == "Hello World"


def test_add():
    assert add(1, 2) == 3


def test_average():
    assert average([1, 2, 3]) == 2


if __name__ == "__main__":
    for test in (test_greet, test_add, test_average):
        try:
            test()
            print(f"PASS {test.__name__}")
        except Exception as e:
            print(f"FAIL {test.__name__}: {e!r}")
