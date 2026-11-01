# Account-level pieces Riff's CI relies on. Applied by an administrator, never by CI:
# CI must not be able to widen its own permissions in this shared AWS account.
#   AWS_PROFILE=wick-dev terraform -chdir=infra/terraform/account init && ... apply
terraform {
  required_version = ">= 1.10"
  required_providers {
    aws = { source = "hashicorp/aws", version = "~> 6.0" }
  }
  backend "s3" {
    bucket       = "riff-tfstate-707938860881"
    key          = "account/terraform.tfstate"
    region       = "us-east-1"
    encrypt      = true
    use_lockfile = true
  }
}

provider "aws" {
  region = var.region
  default_tags {
    tags = { project = "riff", managed-by = "terraform", stack = "riff-account" }
  }
}

variable "region" {
  type    = string
  default = "us-east-1"
}
variable "github_repository" {
  description = "owner/name of the repository allowed to deploy"
  type        = string
  default     = "rogerjeasy/riff"
}
variable "deploy_branch" {
  type    = string
  default = "main"
}

data "aws_caller_identity" "current" {}
locals {
  account  = data.aws_caller_identity.current.account_id
  state    = "arn:aws:s3:::riff-tfstate-${local.account}"
  secrets  = "arn:aws:secretsmanager:${var.region}:${local.account}:secret:riff/prod/*"
  provider = "arn:aws:iam::${local.account}:oidc-provider/token.actions.githubusercontent.com"
}

# The GitHub OIDC provider already exists in this account and is shared with other
# projects, so it is referenced rather than managed here.
data "aws_iam_openid_connect_provider" "github" {
  arn = local.provider
}

data "aws_iam_policy_document" "trust" {
  statement {
    actions = ["sts:AssumeRoleWithWebIdentity"]
    principals {
      type        = "Federated"
      identifiers = [data.aws_iam_openid_connect_provider.github.arn]
    }
    condition {
      test     = "StringEquals"
      variable = "token.actions.githubusercontent.com:aud"
      values   = ["sts.amazonaws.com"]
    }
    # Only workflows running on the deploy branch of this one repository.
    condition {
      test     = "StringEquals"
      variable = "token.actions.githubusercontent.com:sub"
      values   = ["repo:${var.github_repository}:ref:refs/heads/${var.deploy_branch}"]
    }
  }
}

resource "aws_iam_role" "deploy" {
  name                 = "riff-github-deploy"
  description          = "GitHub Actions: apply infra/terraform/prod and deploy Riff"
  assume_role_policy   = data.aws_iam_policy_document.trust.json
  max_session_duration = 3600
}

data "aws_iam_policy_document" "deploy" {
  statement {
    sid = "Lightsail"
    # Lightsail has limited resource-level support; no other project uses it in this account.
    actions   = ["lightsail:*"]
    resources = ["*"]
  }
  statement {
    sid = "RiffSecrets"
    actions = [
      "secretsmanager:CreateSecret",
      "secretsmanager:DescribeSecret",
      "secretsmanager:GetSecretValue",
      "secretsmanager:PutSecretValue",
      "secretsmanager:UpdateSecret",
      "secretsmanager:TagResource",
      "secretsmanager:UntagResource",
      "secretsmanager:GetResourcePolicy",
      "secretsmanager:DeleteSecret",
    ]
    resources = [local.secrets]
  }
  statement {
    sid       = "StateBucket"
    actions   = ["s3:ListBucket"]
    resources = [local.state]
    condition {
      test     = "StringLike"
      variable = "s3:prefix"
      values   = ["prod/*"]
    }
  }
  statement {
    sid       = "StateObjects"
    actions   = ["s3:GetObject", "s3:PutObject", "s3:DeleteObject"]
    resources = ["${local.state}/prod/*"]
  }
  statement {
    sid       = "Identity"
    actions   = ["sts:GetCallerIdentity"]
    resources = ["*"]
  }
}

resource "aws_iam_role_policy" "deploy" {
  name   = "riff-deploy"
  role   = aws_iam_role.deploy.id
  policy = data.aws_iam_policy_document.deploy.json
}

output "deploy_role_arn" {
  value = aws_iam_role.deploy.arn
}
