resource "aws_lb" "this" {
  name                = "keycloak-alb"
  load_balancer_type  = "application"
}

resource "aws_lb_target_group" "keycloak" {
  name = "keycloak-tg"
  port = 8080

  health_check {
    path = "/health"
  }
}
